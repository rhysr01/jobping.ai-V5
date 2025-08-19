// app/api/match-users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { productionRateLimiter } from '@/Utils/productionRateLimiter';
import OpenAI from 'openai';
import {
  generateFallbackMatches,
  logMatchSession,
  AIMatchingCache,
  parseAndValidateMatches,
  type UserPreferences,
} from '@/Utils/jobMatching';
import type { Job } from '@/scrapers/types';
// import { EnhancedRateLimiter } from '@/Utils/enhancedRateLimiter';
import { PerformanceMonitor } from '@/Utils/performanceMonitor';
import { AdvancedMonitoringOracle } from '@/Utils/advancedMonitoring';
import { AutoScalingOracle } from '@/Utils/autoScaling';
import { UserSegmentationOracle } from '@/Utils/userSegmentation';
import type { JobMatch } from '@/Utils/jobMatching';
import { dogstatsd } from '@/Utils/datadogMetrics';

// Helper function to safely normalize string/array fields
function normalizeStringToArray(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    // Handle both comma-separated and pipe-separated strings
    if (value.includes('|')) {
      return value.split('|').map(s => s.trim()).filter(Boolean);
    }
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// Enhanced monitoring and performance tracking
interface PerformanceMetrics {
  jobFetchTime: number;
  tierDistributionTime: number;
  aiMatchingTime: number;
  totalProcessingTime: number;
  memoryUsage: number;
}

// Simple in-memory rate limiting - upgrade to Redis when you scale
const rateLimitMap = new Map<string, number>();
const jobReservationMap = new Map<string, number>(); // Job locking mechanism

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_REQUESTS = 3; // Max 3 requests per 15 minutes

// Performance and cost optimization settings
const MAX_JOBS_PER_USER = {
  free: 50,      // Reduced from 500 to control AI costs
  premium: 100   // Premium gets more but still reasonable
};

// Freshness tier distribution with fallback logic
const TIER_DISTRIBUTION = {
  free: {
    ultra_fresh: 2,
    fresh: 3, // Updated: Changed from 2 to 3 to total 6 matches per week (2+3+1=6)
    comprehensive: 1,
    fallback_order: ['fresh', 'comprehensive', 'ultra_fresh'] // If tier is empty, try these
  },
  premium: {
    ultra_fresh: 5,
    fresh: 7,
    comprehensive: 3,
    fallback_order: ['fresh', 'ultra_fresh', 'comprehensive']
  }
};

// Production-ready job interface with validation
interface JobWithFreshness {
  id: string;
  title: string;
  company: string;
  location: string;
  job_url: string;
  description: string;
  created_at: string;
  job_hash: string;
  is_sent: boolean;
  status: string;
  freshness_tier: 'ultra_fresh' | 'fresh' | 'comprehensive' | null;
  original_posted_date: string | null;
  last_seen_at: string | null;
}

// NEW: Enhanced rate limiter instance - TEMPORARILY DISABLED FOR TESTS
// const enhancedRateLimiter = new EnhancedRateLimiter();

// NEW: User clustering functionality
interface User extends UserPreferences {
  professional_expertise: string;
  entry_level_preference: string;
}

function clusterSimilarUsers(users: UserPreferences[], maxClusterSize: number = 3): UserPreferences[][] {
  const clusters: UserPreferences[][] = [];
  const processed = new Set<number>();

  for (let i = 0; i < users.length; i++) {
    if (processed.has(i)) continue;

    const cluster = [users[i]];
    processed.add(i);

    // Find similar users (same expertise + experience level)
    for (let j = i + 1; j < users.length && cluster.length < maxClusterSize; j++) {
      if (processed.has(j)) continue;

      const user1 = users[i];
      const user2 = users[j];
      
      if (user1.professional_expertise === user2.professional_expertise &&
          user1.entry_level_preference === user2.entry_level_preference) {
        cluster.push(user2);
        processed.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

// NEW: Enhanced AI matching with clustering and caching
async function performEnhancedAIMatchingWithCaching(
  users: UserPreferences[],
  jobs: JobWithFreshness[],
  openai: OpenAI,
  isNewUser: boolean = false
): Promise<Map<string, JobMatch[]>> {
  console.log(`🤖 Starting enhanced AI matching for ${users.length} users with ${jobs.length} jobs`);

  // Cluster users to reduce API calls
  const userClusters = clusterSimilarUsers(users, 3);
  console.log(`👥 Created ${userClusters.length} clusters from ${users.length} users`);

  const results = new Map<string, JobMatch[]>();

  for (const cluster of userClusters) {
    try {
      // Check cache first
      const cachedMatches = await AIMatchingCache.getCachedMatches(cluster);
      
      if (cachedMatches && !isNewUser) {
        console.log(`🎯 Using cached matches for cluster of ${cluster.length} users`);
        await processCachedMatches(cluster, cachedMatches, jobs, results);
        continue;
      }

      // Perform AI matching for the cluster
      const matchingResults = await callOpenAIForCluster(cluster, jobs, openai);
      
      // Cache the results
      AIMatchingCache.setCachedMatches(cluster, matchingResults);
      
      // Process matches for each user in the cluster
      await processMatchingResults(cluster, matchingResults, results);
      
    } catch (error) {
      console.error(`❌ Error processing cluster:`, error);
      // Fallback logic
      await performRuleBasedMatching(cluster, jobs, results);
    }
  }

  return results;
}

// NEW: Helper function to call OpenAI for a cluster
async function callOpenAIForCluster(userCluster: UserPreferences[], jobs: JobWithFreshness[], openai: OpenAI): Promise<JobMatch[]> {
  // Batch the OpenAI call for the entire cluster
  const clusterPrompt = `
    Analyze these ${userCluster.length} similar users and ${jobs.length} jobs.
    Users: ${JSON.stringify(userCluster.map(u => ({
      expertise: u.professional_expertise,
      experience: u.entry_level_preference,
      location: u.target_cities,
      visa: u.visa_status,
      email: u.email
    })))}
    Jobs: ${JSON.stringify(jobs.slice(0, 10))} // Limit to first 10 jobs for prompt size
  `;
  
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: 'You are an AI job matching expert. Analyze users and jobs to provide personalized matches.'
        },
        {
          role: 'user',
          content: clusterPrompt
        }
      ],
      temperature: 0.3,
      max_tokens: 2000
    });
    
    const response = completion.choices[0]?.message?.content || '';
    return parseAndValidateMatches(response, jobs as unknown as Job[]);
  } catch (error) {
    console.error('OpenAI cluster matching failed:', error);
    return [];
  }
}

// NEW: Process cached matches
async function processCachedMatches(
  userCluster: UserPreferences[], 
  cachedMatches: any[], 
  allJobs: JobWithFreshness[], 
  results: Map<string, JobMatch[]>
): Promise<void> {
  // Adapt cached matches to current job set
  for (const clusterResult of cachedMatches) {
    const userEmail = clusterResult.user_email;
    const userMatches = clusterResult.matches || [];
    
    // Filter matches to jobs that still exist
    const validMatches = userMatches.filter((match: any) => 
      allJobs.some(job => job.job_hash === match.job_hash)
    );

    if (validMatches.length > 0) {
      results.set(userEmail, validMatches);
    }
  }
}

// NEW: Process matching results for a cluster
async function processMatchingResults(
  userCluster: UserPreferences[], 
  matchingResults: any[], 
  results: Map<string, JobMatch[]>
): Promise<void> {
  for (const clusterResult of matchingResults) {
    const userEmail = clusterResult.user_email;
    const userMatches = clusterResult.matches || [];
    
    if (userMatches.length > 0) {
      results.set(userEmail, userMatches);
    }
  }
}

// NEW: Rule-based fallback matching
async function performRuleBasedMatching(
  userCluster: UserPreferences[], 
  jobs: JobWithFreshness[], 
  results: Map<string, JobMatch[]>
): Promise<void> {
  for (const user of userCluster) {
    // Convert JobWithFreshness to Job for compatibility
    const jobCompatible = jobs.map(job => ({
      id: parseInt(job.id) || undefined, // Convert string to number or undefined
      job_hash: job.job_hash,
      title: job.title,
      company: job.company,
      location: job.location,
      job_url: job.job_url,
      description: job.description,
      experience_required: '', // Default value for compatibility
      work_environment: '', // Default value for compatibility
      source: '', // Default value for compatibility
      categories: [], // Default value for compatibility
      company_profile_url: '', // Default value for compatibility
      language_requirements: '', // Default value for compatibility
      scrape_timestamp: new Date().toISOString(), // Default value for compatibility
      original_posted_date: job.original_posted_date || new Date().toISOString(),
      posted_at: job.original_posted_date || new Date().toISOString(),
      last_seen_at: job.last_seen_at || new Date().toISOString(),
      is_active: true, // Default value for compatibility
      freshness_tier: job.freshness_tier || '',
      scraper_run_id: '', // Default value for compatibility
      created_at: job.created_at
    }));
    
    const fallbackMatches = generateFallbackMatches(jobCompatible, user);
    if (fallbackMatches.length > 0) {
      results.set(user.email, fallbackMatches);
    }
  }
}

// Database schema validation
async function validateDatabaseSchema(supabase: any): Promise<boolean> {
  try {
    // Check if required columns exist by attempting a sample query
    const { data, error } = await supabase
      .from('jobs')
      .select('status, freshness_tier, original_posted_date, last_seen_at')
      .limit(1);
    
    if (error) {
      console.error('Database schema validation failed:', error.message);
      return false;
    }
    
    console.log('Database schema validation passed');
    return true;
  } catch (err) {
    console.error('Database schema validation error:', err);
    return false;
  }
}

// Enhanced rate limiting with job reservation
function isRateLimited(identifier: string): boolean {
  const now = Date.now();
  const lastCallTime = rateLimitMap.get(identifier) || 0;
  
  if (now - lastCallTime < RATE_LIMIT_WINDOW_MS) {
    console.log(`Rate limit hit for ${identifier}. Last call: ${new Date(lastCallTime).toISOString()}`);
    return true;
  }
  
  rateLimitMap.set(identifier, now);
  return false;
}

// Job reservation system to prevent race conditions
function reserveJobs(jobIds: string[], reservationId: string): boolean {
  const now = Date.now();
  
  // Check if any jobs are already reserved
  for (const jobId of jobIds) {
    const existingReservation = jobReservationMap.get(jobId);
    if (existingReservation && (now - existingReservation) < 300000) { // 5 minute reservation
      console.log(`Job ${jobId} already reserved`);
      return false;
    }
  }
  
  // Reserve all jobs
  for (const jobId of jobIds) {
    jobReservationMap.set(jobId, now);
  }
  
  return true;
}

// UTC-safe date calculation
function getDateDaysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(0, 0, 0, 0); // Start of day UTC
  return date;
}

// Tier distribution with intelligent fallback logic
function distributeJobsByFreshness(
  jobs: JobWithFreshness[], 
  userTier: 'free' | 'premium' = 'free',
  userId: string
): { jobs: JobWithFreshness[], metrics: any } {
  const startTime = Date.now();
  
  console.log(`Distributing jobs for ${userTier} user ${userId}. Total jobs: ${jobs.length}`);
  
  // Validate and clean job data
  const validJobs = jobs.filter(job => {
    // Skip jobs with invalid data
    if (!job.freshness_tier || !job.original_posted_date) {
      console.warn(`Job ${job.id} missing freshness data, assigning fallback`);
      // Assign fallback freshness tier based on created_at
      job.freshness_tier = assignFallbackFreshnessTier(job.created_at);
      job.original_posted_date = job.created_at; // Use created_at as fallback
    }
    return job.job_hash && job.title && job.company;
  });
  
  // Separate jobs by freshness tier
  const ultraFreshJobs = validJobs.filter(job => job.freshness_tier === 'ultra_fresh');
  const freshJobs = validJobs.filter(job => job.freshness_tier === 'fresh');
  const comprehensiveJobs = validJobs.filter(job => job.freshness_tier === 'comprehensive');
  
  const tierCounts = {
    ultra_fresh: ultraFreshJobs.length,
    fresh: freshJobs.length,
    comprehensive: comprehensiveJobs.length
  };
  
  console.log(`Job breakdown for ${userId} - Ultra Fresh: ${tierCounts.ultra_fresh}, Fresh: ${tierCounts.fresh}, Comprehensive: ${tierCounts.comprehensive}`);
  
  // Get distribution limits based on user tier
  const config = TIER_DISTRIBUTION[userTier];
  const selectedJobs: JobWithFreshness[] = [];
  
  // Smart selection with fallback logic
  selectedJobs.push(...selectJobsFromTier(ultraFreshJobs, config.ultra_fresh, 'ultra_fresh'));
  selectedJobs.push(...selectJobsFromTier(freshJobs, config.fresh, 'fresh'));
  selectedJobs.push(...selectJobsFromTier(comprehensiveJobs, config.comprehensive, 'comprehensive'));
  
  // Fallback logic: if we don't have enough jobs, pull from other tiers
  const targetTotal = config.ultra_fresh + config.fresh + config.comprehensive;
  const maxAllowed = MAX_JOBS_PER_USER[userTier];
  
  if (selectedJobs.length < targetTotal && selectedJobs.length < maxAllowed) {
    const remainingSlots = Math.min(targetTotal - selectedJobs.length, maxAllowed - selectedJobs.length);
    const usedJobHashes = new Set(selectedJobs.map(job => job.job_hash));
    
    // Try fallback tiers in order
    for (const fallbackTier of config.fallback_order) {
      if (remainingSlots <= 0) break;
      
      const tierJobs = validJobs.filter(job => 
        job.freshness_tier === fallbackTier && !usedJobHashes.has(job.job_hash)
      );
      
      const additionalJobs = selectJobsFromTier(tierJobs, remainingSlots, fallbackTier);
      selectedJobs.push(...additionalJobs);
      
      additionalJobs.forEach(job => usedJobHashes.add(job.job_hash));
    }
  }
  
  const processingTime = Date.now() - startTime;
  
  console.log(`Selected ${selectedJobs.length} jobs for ${userId} (${userTier} tier) in ${processingTime}ms`);
  
  return {
    jobs: selectedJobs,
    metrics: {
      processingTime,
      originalJobCount: jobs.length,
      validJobCount: validJobs.length,
      selectedJobCount: selectedJobs.length,
      tierCounts,
      fallbacksUsed: selectedJobs.length < targetTotal
    }
  };
}

// Helper function to select jobs from a specific tier
function selectJobsFromTier(tierJobs: JobWithFreshness[], limit: number, tierName: string): JobWithFreshness[] {
  return tierJobs
    .sort((a, b) => {
      // Primary sort: original posting date (most recent first)
      const dateA = new Date(a.original_posted_date || a.created_at);
      const dateB = new Date(b.original_posted_date || b.created_at);
      if (dateA.getTime() !== dateB.getTime()) {
        return dateB.getTime() - dateA.getTime();
      }
      // Secondary sort: last seen (most recently confirmed first)
      const lastSeenA = new Date(a.last_seen_at || a.created_at);
      const lastSeenB = new Date(b.last_seen_at || b.created_at);
      return lastSeenB.getTime() - lastSeenA.getTime();
    })
    .slice(0, limit);
}

// Fallback freshness tier assignment
function assignFallbackFreshnessTier(createdAt: string): 'ultra_fresh' | 'fresh' | 'comprehensive' {
  const hoursAgo = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  if (hoursAgo <= 48) return 'ultra_fresh';
  if (hoursAgo <= 168) return 'fresh'; // 168 hours = 1 week
  return 'comprehensive';
}

// Performance monitoring utility
function trackPerformance(): { startTime: number; getMetrics: () => PerformanceMetrics } {
  const startTime = Date.now();
  const startMemory = process.memoryUsage().heapUsed;
  
  return {
    startTime,
    getMetrics: () => ({
      jobFetchTime: 0, // Set by caller
      tierDistributionTime: 0, // Set by caller
      aiMatchingTime: 0, // Set by caller
      totalProcessingTime: Date.now() - startTime,
      memoryUsage: process.memoryUsage().heapUsed - startMemory
    })
  };
}

// Pre-filter jobs by user preferences to reduce AI load
function preFilterJobsByUserPreferences(jobs: JobWithFreshness[], user: UserPreferences): JobWithFreshness[] {
  // Basic filtering to reduce AI processing load
  let filteredJobs = jobs;
  
  // Filter by target cities if specified
  if (user.target_cities && user.target_cities.length > 0) {
    filteredJobs = filteredJobs.filter(job => 
      user.target_cities.some(city => 
        job.location.toLowerCase().includes(city.toLowerCase()) ||
        job.location.toLowerCase().includes('remote')
      )
    );
  }
  
  // Filter by experience level keywords in title
  if (user.entry_level_preference) {
    const experienceKeywords: Record<string, string[]> = {
      'entry': ['intern', 'internship', 'graduate', 'grad', 'entry', 'junior', 'trainee', 'associate'],
      'mid': ['analyst', 'specialist', 'coordinator', 'associate'],
      'senior': ['senior', 'lead', 'principal', 'manager', 'director']
    };
    
    const keywords = experienceKeywords[user.entry_level_preference as keyof typeof experienceKeywords] || experienceKeywords['entry'];
    filteredJobs = filteredJobs.filter(job =>
      keywords.some(keyword => job.title.toLowerCase().includes(keyword))
    );
  }
  
  console.log(`Pre-filtered from ${jobs.length} to ${filteredJobs.length} jobs for user ${user.email}`);
  return filteredJobs;
}

// Initialize clients
function getSupabaseClient() {
  // Only initialize during runtime, not build time
  if (typeof window !== 'undefined') {
    throw new Error('Supabase client should only be used server-side');
  }
  
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase configuration');
  }
  
  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function getOpenAIClient() {
  return new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
}

export async function POST(req: NextRequest) {
  const performanceTracker = trackPerformance();
  const reservationId = `batch_${Date.now()}`;
  const requestStartTime = Date.now();
  
  // Extract IP address
  const ip = req.headers.get('x-forwarded-for') || 
             req.headers.get('x-real-ip') || 
             'unknown';
  
  // PRODUCTION: Enhanced rate limiting with Redis fallback
  const rateLimitResult = await productionRateLimiter.middleware(req, 'match-users');
  
  if (rateLimitResult) {
    // Rate limit exceeded, return the 429 response
    return rateLimitResult;
  }
  PerformanceMonitor.trackDuration('rate_limit_check', Date.now());

  try {
    console.log(`Processing match-users request from IP: ${ip}`);
    
    // Validate request body
    let requestBody;
    try {
      requestBody = await req.json();
    } catch (parseError) {
      return NextResponse.json({ 
        error: 'Invalid JSON in request body',
        details: parseError instanceof Error ? parseError.message : 'Unknown parsing error'
      }, { status: 400 });
    }

    // Validate request body structure
    if (requestBody && typeof requestBody === 'object') {
      // Validate field types
      if (requestBody.limit !== undefined && (typeof requestBody.limit !== 'number' || requestBody.limit < 1)) {
        return NextResponse.json({ 
          error: 'Invalid limit parameter. Must be a positive number.',
          received: requestBody.limit
        }, { status: 400 });
      }
      
      if (requestBody.forceReprocess !== undefined && typeof requestBody.forceReprocess !== 'boolean') {
        return NextResponse.json({ 
          error: 'Invalid forceReprocess parameter. Must be a boolean.',
          received: requestBody.forceReprocess
        }, { status: 400 });
      }
    }

    const { limit = 1000, forceReprocess = false } = requestBody || {};
    const supabase = getSupabaseClient();
    
    // Validate database schema before proceeding
    const isSchemaValid = await validateDatabaseSchema(supabase);
    if (!isSchemaValid) {
      return NextResponse.json({ 
        error: 'Database schema validation failed. Missing required columns: status, freshness_tier, original_posted_date, last_seen_at' 
      }, { status: 500 });
    }

    // ADVANCED: Check scaling needs before processing
    let scalingRecommendations: any[] = [];
    try {
      scalingRecommendations = await AutoScalingOracle.checkScalingNeeds();
      if (scalingRecommendations.length > 0) {
        console.log('🔧 Scaling recommendations detected:', scalingRecommendations);
        // Implement critical recommendations automatically
        for (const recommendation of scalingRecommendations.filter(r => r.priority === 'high')) {
          await AutoScalingOracle.implementRecommendation(recommendation);
        }
      }
    } catch (error) {
      console.warn('Scaling check failed:', error);
    }

    // 1. Fetch active users
    const userFetchStart = Date.now();
    let usersQuery = supabase.from('users').select('*');
    
    // Check if email_verified column exists, if not use a fallback
    let users: any[] = [];
    let usersError: any = null;
    
    try {
      const result = await usersQuery.eq('email_verified', true);
      users = result.data || [];
      usersError = result.error;
    } catch (error: any) {
      // Fallback: fetch all users if email_verified column doesn't exist
      console.log('email_verified column not found, fetching all users');
      const result = await supabase.from('users').select('*');
      users = result.data || [];
      usersError = result.error;
    }
    
    PerformanceMonitor.trackDuration('user_fetch', userFetchStart);

    if (usersError) {
      console.error('Failed to fetch users:', usersError);
      return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
    }

    if (!users || users.length === 0) {
      console.log('No users found');
      return NextResponse.json({ message: 'No users found' });
    }

    console.log(`Found ${users.length} active users to process`);

    // Transform user data to match expected format (handle TEXT[] arrays from your schema)
    const transformedUsers = users.map((user: any) => ({
      ...user,
      target_cities: normalizeStringToArray(user.target_cities),
      languages_spoken: normalizeStringToArray(user.languages_spoken),
      company_types: normalizeStringToArray(user.company_types),
      roles_selected: normalizeStringToArray(user.roles_selected),
      professional_expertise: user.professional_experience || '',
    }));

    // ADVANCED: User segmentation analysis
    const userSegmentationStart = Date.now();
    let userSegments: any = { error: 'Not available' };
    try {
      userSegments = await UserSegmentationOracle.analyzeUserBehavior(supabase);
      PerformanceMonitor.trackDuration('user_segmentation', userSegmentationStart);

      if (userSegments.error) {
        console.warn('User segmentation failed:', userSegments.error);
      } else {
        console.log('👥 User segmentation completed:', userSegments.segmentDistribution);
      }
    } catch (error) {
      console.warn('User segmentation failed:', error);
      PerformanceMonitor.trackDuration('user_segmentation', userSegmentationStart);
    }

    // 2. Fetch jobs with UTC-safe date calculation
    const jobFetchStart = Date.now();
    const thirtyDaysAgo = getDateDaysAgo(30);

    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select(`
        id,
        title,
        company,
        location,
        job_url,
        description,
        created_at,
        job_hash,
        is_sent,
        status,
        freshness_tier,
        original_posted_date,
        last_seen_at
      `)
      .gte('created_at', thirtyDaysAgo.toISOString())
      .eq('is_sent', false)
      .eq('status', 'active')
      .order('original_posted_date', { ascending: false })
      .limit(limit);

    const jobFetchTime = Date.now() - jobFetchStart;
    PerformanceMonitor.trackDuration('job_fetch', jobFetchStart);

    if (jobsError) {
      console.error('Failed to fetch jobs:', jobsError);
      return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 });
    }

    if (!jobs || jobs.length === 0) {
      console.log('No active jobs to process');
      return NextResponse.json({ message: 'No active jobs to process' });
    }

    console.log(`Found ${jobs.length} active jobs from past 30 days in ${jobFetchTime}ms`);

    // Reserve jobs to prevent race conditions
    const jobIds = jobs.map(job => job.id);
    if (!reserveJobs(jobIds, reservationId)) {
      console.warn('Jobs already reserved by another process');
      return NextResponse.json({ 
        error: 'Jobs currently being processed by another instance. Try again in a few minutes.' 
      }, { status: 409 });
    }

    // Log overall freshness distribution
    const globalTierCounts = jobs.reduce((acc, job) => {
      const tier = job.freshness_tier || 'unknown';
      acc[tier] = (acc[tier] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log('Global job freshness distribution:', globalTierCounts);

    // 3. Process each user with enhanced error handling
    const results = [];
    let totalAIProcessingTime = 0;
    let totalTierDistributionTime = 0;
    
    for (const user of transformedUsers) {
      try {
        console.log(`Processing matches for ${user.email} (tier: ${user.tier || 'free'})`);
        
        // ADVANCED: Get user analysis for personalized processing
        const userAnalysisStart = Date.now();
        let userAnalysis: any = { error: 'Not available' };
        try {
          userAnalysis = await UserSegmentationOracle.getUserAnalysis(user.id, supabase);
          PerformanceMonitor.trackDuration('user_analysis', userAnalysisStart);

          if ('error' in userAnalysis) {
            console.warn(`User analysis failed for ${user.email}:`, userAnalysis.error);
          } else {
            console.log(`📊 User analysis for ${user.email}:`, {
              engagementScore: userAnalysis.engagementScore,
              segments: userAnalysis.segments,
              recommendations: userAnalysis.recommendations.length
            });
          }
        } catch (error) {
          console.warn(`User analysis failed for ${user.email}:`, error);
          PerformanceMonitor.trackDuration('user_analysis', userAnalysisStart);
        }
        
        // Pre-filter jobs to reduce AI processing load
        const preFilterStart = Date.now();
        const preFilteredJobs = preFilterJobsByUserPreferences(jobs as JobWithFreshness[], user);
        PerformanceMonitor.trackDuration('job_prefilter', preFilterStart);
        
        // Apply freshness distribution with fallback logic
        const tierDistributionStart = Date.now();
        const { jobs: distributedJobs, metrics: tierMetrics } = distributeJobsByFreshness(
          preFilteredJobs, 
          user.tier || 'free',
          user.email
        );
        const tierDistributionTime = Date.now() - tierDistributionStart;
        totalTierDistributionTime += tierDistributionTime;
        PerformanceMonitor.trackDuration('tier_distribution', tierDistributionStart);

        // AI matching with performance tracking
        let matches: JobMatch[] = [];
        let matchType: 'ai_success' | 'fallback' | 'ai_failed' = 'ai_success';
        const aiMatchingStart = Date.now();

        try {
          const openai = getOpenAIClient();
          const matchesMap = await performEnhancedAIMatchingWithCaching(
            [user], // Pass a single user for now, will be clustered later
            distributedJobs,
            openai,
            true // Indicate this is a new user for caching
          );
          
          // Extract matches for this user from the Map
          matches = matchesMap.get(user.email) || [];
          
          if (!matches || matches.length === 0) {
            matchType = 'fallback';
            // Convert JobWithFreshness to Job for compatibility
            const jobCompatible = distributedJobs.map(job => ({
              id: parseInt(job.id) || undefined,
              job_hash: job.job_hash,
              title: job.title,
              company: job.company,
              location: job.location,
              job_url: job.job_url,
              description: job.description,
              experience_required: '',
              work_environment: '',
              source: '',
              categories: [],
              company_profile_url: '',
              language_requirements: '',
              scrape_timestamp: new Date().toISOString(),
              original_posted_date: job.original_posted_date || new Date().toISOString(),
              posted_at: job.original_posted_date || new Date().toISOString(),
              last_seen_at: job.last_seen_at || new Date().toISOString(),
              is_active: true,
              freshness_tier: job.freshness_tier || '',
              scraper_run_id: '',
              created_at: job.created_at
            }));
            matches = generateFallbackMatches(jobCompatible, user);
          }
        } catch (err) {
          console.error(`AI matching failed for ${user.email}:`, err);
          matchType = 'ai_failed';
          // Convert JobWithFreshness to Job for compatibility
          const jobCompatible = distributedJobs.map(job => ({
            id: parseInt(job.id) || undefined,
            job_hash: job.job_hash,
            title: job.title,
            company: job.company,
            location: job.location,
            job_url: job.job_url,
            description: job.description,
            experience_required: '',
            work_environment: '',
            source: '',
            categories: [],
            company_profile_url: '',
            language_requirements: '',
            scrape_timestamp: new Date().toISOString(),
            original_posted_date: job.original_posted_date || new Date().toISOString(),
            posted_at: job.original_posted_date || new Date().toISOString(),
            last_seen_at: job.last_seen_at || new Date().toISOString(),
            is_active: true,
            freshness_tier: job.freshness_tier || '',
            scraper_run_id: '',
            created_at: job.created_at
          }));
          matches = generateFallbackMatches(jobCompatible, user);
        }
        
        const aiMatchingTime = Date.now() - aiMatchingStart;
        totalAIProcessingTime += aiMatchingTime;
        PerformanceMonitor.trackDuration('ai_matching', aiMatchingStart);

        // Save matches with enhanced data
        if (matches && matches.length > 0) {
          const matchEntries = matches.map(match => {
            const originalJob = distributedJobs.find(job => job.job_hash === match.job_hash);
            
            return {
            user_email: user.email,
            job_hash: match.job_hash,
            match_score: match.match_score,
            match_reason: match.match_reason,
            match_quality: match.match_quality,
            match_tags: match.match_tags,
              freshness_tier: originalJob?.freshness_tier || 'comprehensive',
              processing_method: matchType,
            matched_at: new Date().toISOString(),
              created_at: new Date().toISOString()
            };
          });

          const { error: insertError } = await supabase
            .from('matches')
            .insert(matchEntries);

          if (insertError) {
            console.error(`Failed to save matches for ${user.email}:`, insertError);
          }
        }

        // Enhanced logging
        await logMatchSession(
          user.email,
          matchType,
          distributedJobs.length,
          matches.length
        );

        // Calculate tier distribution for results
        const matchTierCounts = matches.reduce((acc, match) => {
          const job = distributedJobs.find(j => j.job_hash === match.job_hash);
          if (job?.freshness_tier) {
            acc[job.freshness_tier] = (acc[job.freshness_tier] || 0) + 1;
          }
          return acc;
        }, {} as Record<string, number>);

        results.push({
          user_email: user.email,
          user_tier: user.tier || 'free',
          matches_count: matches.length,
          tier_distribution: matchTierCounts,
          tier_metrics: tierMetrics,
          performance: {
            tier_distribution_time: tierDistributionTime,
            ai_matching_time: aiMatchingTime,
            pre_filter_reduction: preFilteredJobs.length / jobs.length
          },
          fallback_used: matchType !== 'ai_success',
          processing_method: matchType,
          user_analysis: 'error' in userAnalysis ? null : {
            engagementScore: userAnalysis.engagementScore,
            segments: userAnalysis.segments,
            recommendations: userAnalysis.recommendations
          }
        });

      } catch (userError) {
        console.error(`Error processing user ${user.email}:`, userError);
        
        results.push({
          user_email: user.email,
          user_tier: user.tier || 'free',
          matches_count: 0,
          tier_distribution: {},
          error: userError instanceof Error ? userError.message : 'Unknown error'
        });
      }
    }

    // ADVANCED: Generate comprehensive monitoring report
    const monitoringStart = Date.now();
    let monitoringReport: any = { health: { overall: 'unknown' } };
    try {
      monitoringReport = await AdvancedMonitoringOracle.generateDailyReport();
      PerformanceMonitor.trackDuration('monitoring_report', monitoringStart);
    } catch (error) {
      console.warn('Monitoring report generation failed:', error);
      PerformanceMonitor.trackDuration('monitoring_report', monitoringStart);
    }

    // Log performance report
    PerformanceMonitor.logPerformanceReport();

    const totalProcessingTime = Date.now() - performanceTracker.startTime;
    const performanceMetrics = performanceTracker.getMetrics();

    // Track production metrics for Datadog monitoring
    const requestDuration = Date.now() - requestStartTime;
    
    dogstatsd.histogram('jobping.match.latency_ms', requestDuration);
    dogstatsd.histogram('jobping.match.ai_processing_ms', totalAIProcessingTime);
    dogstatsd.increment('jobping.match.requests', 1, [`status:success`, `users:${users.length}`]);
    
    return NextResponse.json({
      success: true,
      message: `Processed ${users.length} users with ${jobs.length} jobs`,
      results,
      performance: {
        total_processing_time: totalProcessingTime,
        job_fetch_time: jobFetchTime,
        total_tier_distribution_time: totalTierDistributionTime,
        total_ai_processing_time: totalAIProcessingTime,
        average_ai_matching_time: totalAIProcessingTime / users.length,
        memory_usage: performanceMetrics.memoryUsage
      },
      rate_limit: null, // Rate limit info not available in this context
      advanced_insights: {
        user_segmentation: userSegments.error ? null : userSegments.segmentDistribution,
        scaling_recommendations: scalingRecommendations,
        monitoring_report: monitoringReport,
        system_health: monitoringReport.health
      }
    });

  } catch (error) {
    console.error('Match-users processing error:', error);
    return NextResponse.json({ 
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

// Enhanced GET endpoint with tier analytics
export async function GET(req: NextRequest) {
  // Return 405 for GET method as this endpoint is primarily for POST
  return NextResponse.json({ 
    error: 'Method not allowed. This endpoint is designed for POST requests only.' 
  }, { status: 405 });
}