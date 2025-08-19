import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { productionRateLimiter } from '@/Utils/productionRateLimiter';
import { sendMatchedJobsEmail } from '@/Utils/emailUtils';
import { 
  performEnhancedAIMatching, 
  generateFallbackMatches,
  logMatchSession,
  type UserPreferences 
} from '@/Utils/jobMatching';
import OpenAI from 'openai';

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
  // PRODUCTION: Rate limiting for scheduled emails (should only be called by automation)
  const rateLimitResult = await productionRateLimiter.middleware(req, 'send-scheduled-emails');
  if (rateLimitResult) {
    return rateLimitResult;
  }

  // Verify API key for security
  const apiKey = req.headers.get('x-api-key');
  if (apiKey !== process.env.SCRAPE_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('🚀 Starting scheduled email delivery...');
    const supabase = getSupabaseClient();

    // Get all active users who signed up more than 48 hours ago
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    
    console.log('🔍 Querying users with conditions:', {
      email_verified: true,
      subscription_active: true,
      created_at_lt: fortyEightHoursAgo.toISOString()
    });
    
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('*')
      .eq('email_verified', true)
      .eq('subscription_active', true)
      .lt('created_at', fortyEightHoursAgo.toISOString())
      .order('created_at', { ascending: false });

    if (usersError) {
      console.error('❌ Failed to fetch users:', usersError);
      return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
    }

    if (!users || users.length === 0) {
      console.log('ℹ️ No users eligible for scheduled emails');
      return NextResponse.json({ 
        success: true, 
        message: 'No users eligible for scheduled emails',
        usersProcessed: 0 
      });
    }

    console.log(`📧 Processing ${users.length} users for scheduled emails`);

    // Get fresh jobs from the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select('*')
      .eq('status', 'active')
      .gte('created_at', sevenDaysAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(1000);

    if (jobsError) {
      console.error('❌ Failed to fetch jobs:', jobsError);
      return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 });
    }

    if (!jobs || jobs.length === 0) {
      console.log('ℹ️ No active jobs available for matching');
      return NextResponse.json({ 
        success: true, 
        message: 'No active jobs available',
        usersProcessed: 0 
      });
    }

    console.log(`📋 Found ${jobs.length} active jobs for matching`);

    const openai = getOpenAIClient();
    let successCount = 0;
    let errorCount = 0;

    // Process each user
    for (const user of users) {
      try {
        console.log(`🎯 Processing user: ${user.email}`);

        // Convert user data to UserPreferences format
        // Parse comma-separated text fields into arrays per database schema
        const userPreferences: UserPreferences = {
          email: user.email,
          full_name: user.full_name || '',
          target_cities: normalizeStringToArray(user.target_cities),
          languages_spoken: normalizeStringToArray(user.languages_spoken),
          company_types: normalizeStringToArray(user.company_types),
          roles_selected: normalizeStringToArray(user.roles_selected),
          professional_expertise: user.professional_expertise || 'entry',
          visa_status: user.visa_status || 'unknown',
          start_date: user.start_date ? new Date(user.start_date).toISOString() : new Date().toISOString(),
          work_environment: user.work_environment || 'any',
          career_path: user.career_path || '',
          entry_level_preference: user.entry_level_preference || 'entry'
        };

        // Perform AI matching
        let matches;
        let matchType: 'ai_success' | 'ai_failed' | 'fallback' = 'ai_success';
        
        try {
          matches = await performEnhancedAIMatching(jobs, userPreferences, openai);
          
          if (!matches || matches.length === 0) {
            matchType = 'fallback';
            matches = generateFallbackMatches(jobs, userPreferences);
          }
        } catch (aiError) {
          console.error(`❌ AI matching failed for ${user.email}:`, aiError);
          matchType = 'ai_failed';
          matches = generateFallbackMatches(jobs, userPreferences);
        }

        // Limit matches based on subscription tier
        const maxMatches = (user.subscription_tier === 'premium') ? 15 : 5;
        matches = matches.slice(0, maxMatches);

        // Log match session
        await logMatchSession(
          user.email,
          matchType,
          jobs.length,
          matches.length
        );

        // Send email if we have matches
        if (matches.length > 0) {
          await sendMatchedJobsEmail({
            to: user.email,
            jobs: matches,
            userName: user.full_name,
            subscriptionTier: (user.subscription_tier as 'free' | 'premium') || 'free',
            isSignupEmail: false
          });
          
          console.log(`✅ Email sent to ${user.email} with ${matches.length} matches`);
          successCount++;
        } else {
          console.log(`⚠️ No matches found for ${user.email}`);
        }

        // Add small delay to avoid overwhelming the email service
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`❌ Failed to process user ${user.email}:`, error);
        errorCount++;
      }
    }

    console.log(`📊 Scheduled email delivery completed:`);
    console.log(`   ✅ Success: ${successCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);
    console.log(`   📧 Total processed: ${users.length}`);

    return NextResponse.json({
      success: true,
      message: 'Scheduled email delivery completed',
      usersProcessed: users.length,
      emailsSent: successCount,
      errors: errorCount
    });

  } catch (error) {
    console.error('❌ Scheduled email delivery failed:', error);
    return NextResponse.json({
      error: 'Scheduled email delivery failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ 
    error: 'Method not allowed. This endpoint is designed for POST requests only.'
  }, { status: 405 });
}
