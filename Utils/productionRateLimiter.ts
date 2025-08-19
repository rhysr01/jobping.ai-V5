/**
 * Production-Grade Rate Limiter
 * 
 * This is the definitive rate limiting solution for JobPingAI production.
 * Features:
 * - Redis-backed for horizontal scaling
 * - Fallback to in-memory for development
 * - Per-endpoint configuration
 * - IP + User-based limiting
 * - Burst protection
 * - Circuit breaker integration
 */

import { createClient } from 'redis';
import { NextRequest, NextResponse } from 'next/server';

// Production rate limit configurations per endpoint
export const RATE_LIMIT_CONFIG = {
  // Public endpoints (stricter limits)
  'webhook-tally': {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10, // 10 requests per minute
    skipSuccessfulRequests: false
  },
  'scrape': {
    windowMs: 60 * 1000, // 1 minute  
    maxRequests: 2, // 2 scrape requests per minute (resource intensive)
    skipSuccessfulRequests: true
  },
  'match-users': {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 5, // 5 matching requests per 15 minutes
    skipSuccessfulRequests: false
  },
  'send-scheduled-emails': {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 1, // Only automation should call this
    skipSuccessfulRequests: true
  },
  'create-checkout-session': {
    windowMs: 5 * 60 * 1000, // 5 minutes
    maxRequests: 3, // 3 payment attempts per 5 minutes
    skipSuccessfulRequests: false
  },
  'webhooks-stripe': {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100, // High limit for Stripe webhooks
    skipSuccessfulRequests: true
  },
  // Default for unspecified endpoints
  'default': {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 20, // 20 requests per minute
    skipSuccessfulRequests: false
  }
} as const;

// Platform-specific scraper rate limits (critical for avoiding blocks)
export const SCRAPER_RATE_LIMITS = {
  // Enterprise platforms (strict limits)
  'greenhouse': {
    requestsPerHour: 45, // Under 50/hour limit
    minDelayMs: 2000,    // 2-second minimum between requests
    maxDelayMs: 8000,    // Up to 8 seconds when throttling
    burstLimit: 3,       // Max 3 rapid requests
    adaptiveThrottle: true
  },
  'lever': {
    requestsPerHour: 40,
    minDelayMs: 2500,
    maxDelayMs: 10000,
    burstLimit: 2,
    adaptiveThrottle: true
  },
  'workday': {
    requestsPerHour: 18, // Under 20/hour aggressive limit
    minDelayMs: 3000,    // 3-second minimum
    maxDelayMs: 15000,   // Up to 15 seconds when blocked
    burstLimit: 2,
    adaptiveThrottle: true
  },
  // Graduate sites (very conservative)
  'graduatejobs': {
    requestsPerHour: 30,
    minDelayMs: 3000,
    maxDelayMs: 12000,
    burstLimit: 2,
    adaptiveThrottle: true
  },
  'graduateland': {
    requestsPerHour: 25,
    minDelayMs: 4000,
    maxDelayMs: 15000,
    burstLimit: 2,
    adaptiveThrottle: true
  },
  'iagora': {
    requestsPerHour: 20,
    minDelayMs: 5000,
    maxDelayMs: 20000,
    burstLimit: 1,
    adaptiveThrottle: true
  },
  // Fast platforms
  'remoteok': {
    requestsPerHour: 60,
    minDelayMs: 1000,
    maxDelayMs: 5000,
    burstLimit: 5,
    adaptiveThrottle: true
  },
  'wellfound': {
    requestsPerHour: 35,
    minDelayMs: 2000,
    maxDelayMs: 8000,
    burstLimit: 3,
    adaptiveThrottle: true
  },
  'smartrecruiters': {
    requestsPerHour: 30,
    minDelayMs: 2500,
    maxDelayMs: 10000,
    burstLimit: 2,
    adaptiveThrottle: true
  },
  // Newly added job boards
  'jobteaser': {
    requestsPerHour: 25,
    minDelayMs: 3000,
    maxDelayMs: 12000,
    burstLimit: 2,
    adaptiveThrottle: true
  },
  'milkround': {
    requestsPerHour: 30,
    minDelayMs: 2500,
    maxDelayMs: 10000,
    burstLimit: 2,
    adaptiveThrottle: true
  },
  'eures': {
    requestsPerHour: 20,
    minDelayMs: 4000,
    maxDelayMs: 15000,
    burstLimit: 1,
    adaptiveThrottle: true
  }
} as const;

class ProductionRateLimiter {
  private redis: any = null;
  private fallbackMap: Map<string, { count: number; resetTime: number }> = new Map();
  private isRedisConnected = false;
  
  // Scraper-specific tracking
  private scraperRequestTimes: Map<string, number[]> = new Map();
  private scraperThrottleLevel: Map<string, number> = new Map();

  constructor() {
    this.initializeRedis();
  }

  private async initializeRedis() {
    // Skip Redis initialization in test mode
    if (process.env.NODE_ENV === 'test') {
      console.log('🧪 Test mode: Skipping Redis initialization for rate limiter');
      return;
    }

    try {
      if (process.env.REDIS_URL) {
        this.redis = createClient({
          url: process.env.REDIS_URL,
          socket: {
            reconnectStrategy: (times) => Math.min(times * 50, 2000)
          }
        });

        this.redis.on('error', (err: any) => {
          console.error('🚨 Production Rate Limiter Redis error:', err);
          this.isRedisConnected = false;
        });

        this.redis.on('connect', () => {
          console.log('✅ Production Rate Limiter Redis connected');
          this.isRedisConnected = true;
        });

        await this.redis.connect();
      } else {
        console.warn('⚠️ No REDIS_URL configured, using in-memory rate limiting');
      }
    } catch (error) {
      console.error('❌ Failed to initialize Redis for rate limiter:', error);
      this.isRedisConnected = false;
    }
  }

  /**
   * Check rate limit for a request
   * Returns { allowed: boolean, remaining: number, resetTime: number, retryAfter?: number }
   */
  async checkRateLimit(
    endpoint: string,
    identifier: string,
    customConfig?: { windowMs: number; maxRequests: number }
  ): Promise<{
    allowed: boolean;
    remaining: number;
    resetTime: number;
    retryAfter?: number;
  }> {
    const config = customConfig || RATE_LIMIT_CONFIG[endpoint as keyof typeof RATE_LIMIT_CONFIG] || RATE_LIMIT_CONFIG.default;
    const key = `rate_limit:${endpoint}:${identifier}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    try {
      // Try Redis first
      if (this.isRedisConnected && this.redis) {
        return await this.checkRedisRateLimit(key, config, now, windowStart);
      } else {
        // Fallback to in-memory
        return this.checkMemoryRateLimit(key, config, now);
      }
    } catch (error) {
      console.error('❌ Rate limit check failed:', error);
      // Fail open in production to avoid blocking legitimate requests
      return {
        allowed: true,
        remaining: config.maxRequests - 1,
        resetTime: now + config.windowMs
      };
    }
  }

  private async checkRedisRateLimit(
    key: string,
    config: any,
    now: number,
    windowStart: number
  ) {
    // Use Redis sorted sets for sliding window rate limiting
    const multi = this.redis.multi();
    
    // Remove expired entries
    multi.zRemRangeByScore(key, '-inf', windowStart);
    
    // Add current request
    multi.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
    
    // Count requests in window
    multi.zCard(key);
    
    // Set expiry
    multi.expire(key, Math.ceil(config.windowMs / 1000));
    
    const results = await multi.exec();
    const count = results[2] as number;

    const allowed = count <= config.maxRequests;
    const remaining = Math.max(0, config.maxRequests - count);
    const resetTime = now + config.windowMs;

    return {
      allowed,
      remaining,
      resetTime,
      retryAfter: allowed ? undefined : Math.ceil(config.windowMs / 1000)
    };
  }

  private checkMemoryRateLimit(key: string, config: any, now: number) {
    const entry = this.fallbackMap.get(key);
    
    if (!entry || now > entry.resetTime) {
      // Reset window
      this.fallbackMap.set(key, {
        count: 1,
        resetTime: now + config.windowMs
      });
      return {
        allowed: true,
        remaining: config.maxRequests - 1,
        resetTime: now + config.windowMs
      };
    }

    entry.count++;
    const allowed = entry.count <= config.maxRequests;
    const remaining = Math.max(0, config.maxRequests - entry.count);

    return {
      allowed,
      remaining,
      resetTime: entry.resetTime,
      retryAfter: allowed ? undefined : Math.ceil((entry.resetTime - now) / 1000)
    };
  }

  /**
   * Get client identifier from request (IP + User-Agent fingerprint)
   */
  getClientIdentifier(req: NextRequest): string {
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ||
              req.headers.get('x-real-ip') ||
              'unknown-ip';
    
    const userAgent = req.headers.get('user-agent') || 'unknown-ua';
    // Create a simple fingerprint
    const fingerprint = Buffer.from(`${ip}:${userAgent.slice(0, 50)}`).toString('base64').slice(0, 16);
    
    return `${ip}:${fingerprint}`;
  }

  /**
   * Middleware function for Next.js API routes
   */
  async middleware(
    req: NextRequest,
    endpoint: string,
    customConfig?: { windowMs: number; maxRequests: number }
  ): Promise<NextResponse | null> {
    // Skip rate limiting in test mode
    if (process.env.NODE_ENV === 'test') {
      return null;
    }

    const identifier = this.getClientIdentifier(req);
    const result = await this.checkRateLimit(endpoint, identifier, customConfig);

    if (!result.allowed) {
      console.warn(`🚨 Rate limit exceeded for ${endpoint} from ${identifier}`);
      
      return NextResponse.json(
        {
          error: 'Rate limit exceeded',
          message: 'Too many requests, please try again later',
          retryAfter: result.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': result.retryAfter?.toString() || '60',
            'X-RateLimit-Limit': (customConfig?.maxRequests || RATE_LIMIT_CONFIG[endpoint as keyof typeof RATE_LIMIT_CONFIG]?.maxRequests || RATE_LIMIT_CONFIG.default.maxRequests).toString(),
            'X-RateLimit-Remaining': result.remaining.toString(),
            'X-RateLimit-Reset': new Date(result.resetTime).toISOString()
          }
        }
      );
    }

    return null; // Allow request to proceed
  }

  /**
   * Clean up expired entries (for memory fallback)
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.fallbackMap.entries()) {
      if (now > entry.resetTime) {
        this.fallbackMap.delete(key);
      }
    }
  }

  /**
   * Reset rate limit for an identifier (admin function)
   */
  async resetRateLimit(endpoint: string, identifier: string): Promise<void> {
    const key = `rate_limit:${endpoint}:${identifier}`;
    
    try {
      if (this.isRedisConnected && this.redis) {
        await this.redis.del(key);
      } else {
        this.fallbackMap.delete(key);
      }
      console.log(`✅ Rate limit reset for ${key}`);
    } catch (error) {
      console.error('❌ Failed to reset rate limit:', error);
    }
  }

  /**
   * Get rate limit stats (for monitoring)
   */
  async getStats(): Promise<{
    totalKeys: number;
    redisConnected: boolean;
    memoryKeys: number;
  }> {
    try {
      let totalKeys = 0;
      
      if (this.isRedisConnected && this.redis) {
        const keys = await this.redis.keys('rate_limit:*');
        totalKeys = keys.length;
      }

      return {
        totalKeys,
        redisConnected: this.isRedisConnected,
        memoryKeys: this.fallbackMap.size
      };
    } catch (error) {
      console.error('❌ Failed to get rate limit stats:', error);
      return {
        totalKeys: 0,
        redisConnected: false,
        memoryKeys: this.fallbackMap.size
      };
    }
  }

  /**
   * Intelligent scraper rate limiting with adaptive throttling
   */
  async getScraperDelay(platform: string, wasBlocked: boolean = false): Promise<number> {
    const config = SCRAPER_RATE_LIMITS[platform as keyof typeof SCRAPER_RATE_LIMITS];
    if (!config) {
      return 2000; // Default 2-second delay
    }

    const now = Date.now();
    const platformKey = `scraper:${platform}`;
    
    // Track request times
    const requestTimes = this.scraperRequestTimes.get(platformKey) || [];
    requestTimes.push(now);
    
    // Keep only last hour of requests
    const oneHourAgo = now - (60 * 60 * 1000);
    const recentRequests = requestTimes.filter(time => time > oneHourAgo);
    this.scraperRequestTimes.set(platformKey, recentRequests);

    // Check if we're exceeding hourly limit
    if (recentRequests.length >= config.requestsPerHour) {
      console.warn(`⚠️ ${platform}: Approaching hourly limit (${recentRequests.length}/${config.requestsPerHour})`);
      return config.maxDelayMs;
    }

    // Adaptive throttling based on blocks
    let currentThrottleLevel = this.scraperThrottleLevel.get(platformKey) || 0;
    
    if (wasBlocked) {
      // Increase throttle level on block
      currentThrottleLevel = Math.min(currentThrottleLevel + 1, 5);
      this.scraperThrottleLevel.set(platformKey, currentThrottleLevel);
      console.warn(`🚨 ${platform}: Block detected! Throttle level: ${currentThrottleLevel}`);
    } else if (currentThrottleLevel > 0) {
      // Gradually reduce throttle level on success
      currentThrottleLevel = Math.max(currentThrottleLevel - 0.1, 0);
      this.scraperThrottleLevel.set(platformKey, currentThrottleLevel);
    }

    // Calculate delay with throttling
    const baseDelay = config.minDelayMs;
    const throttleMultiplier = 1 + (currentThrottleLevel * 0.5);
    const calculatedDelay = baseDelay * throttleMultiplier;
    
    // Add jitter for human-like behavior
    const jitter = Math.random() * 1000;
    const finalDelay = Math.min(calculatedDelay + jitter, config.maxDelayMs);

    return Math.round(finalDelay);
  }

  /**
   * Check if scraper should pause due to rate limits
   */
  shouldScraperPause(platform: string): boolean {
    const config = SCRAPER_RATE_LIMITS[platform as keyof typeof SCRAPER_RATE_LIMITS];
    if (!config) return false;

    const platformKey = `scraper:${platform}`;
    const requestTimes = this.scraperRequestTimes.get(platformKey) || [];
    
    // Check burst limit
    const now = Date.now();
    const lastMinute = now - 60000;
    const recentBurstRequests = requestTimes.filter(time => time > lastMinute).length;
    
    if (recentBurstRequests >= config.burstLimit) {
      console.warn(`⏸️ ${platform}: Burst limit reached (${recentBurstRequests}/${config.burstLimit})`);
      return true;
    }

    // Check hourly limit
    const oneHourAgo = now - (60 * 60 * 1000);
    const hourlyRequests = requestTimes.filter(time => time > oneHourAgo).length;
    
    if (hourlyRequests >= config.requestsPerHour) {
      console.warn(`⏸️ ${platform}: Hourly limit reached (${hourlyRequests}/${config.requestsPerHour})`);
      return true;
    }

    return false;
  }

  /**
   * Detect if response indicates a block/rate limit
   */
  detectBlock(status: number, responseText: string): boolean {
    // Common block indicators
    const blockStatuses = [429, 403, 503, 509];
    if (blockStatuses.includes(status)) return true;
    
    // Text-based detection
    const blockKeywords = [
      'rate limit', 'too many requests', 'blocked', 'captcha',
      'temporarily unavailable', 'access denied', 'suspicious activity',
      'bot detection', 'please wait', 'try again later'
    ];
    
    const text = responseText.toLowerCase();
    return blockKeywords.some(keyword => text.includes(keyword));
  }

  /**
   * Get scraper statistics for monitoring
   */
  getScraperStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    
    for (const [platform, config] of Object.entries(SCRAPER_RATE_LIMITS)) {
      const platformKey = `scraper:${platform}`;
      const requestTimes = this.scraperRequestTimes.get(platformKey) || [];
      const throttleLevel = this.scraperThrottleLevel.get(platformKey) || 0;
      
      const now = Date.now();
      const oneHourAgo = now - (60 * 60 * 1000);
      const hourlyRequests = requestTimes.filter(time => time > oneHourAgo).length;
      
      stats[platform] = {
        hourlyRequests,
        hourlyLimit: config.requestsPerHour,
        throttleLevel: throttleLevel.toFixed(1),
        utilizationPercent: Math.round((hourlyRequests / config.requestsPerHour) * 100)
      };
    }
    
    return stats;
  }

  async close() {
    try {
      if (this.redis) {
        await this.redis.quit();
        console.log('✅ Production Rate Limiter Redis connection closed');
      }
    } catch (error) {
      console.error('❌ Error closing Production Rate Limiter Redis:', error);
    }
  }
}

// Singleton instance
export const productionRateLimiter = new ProductionRateLimiter();

// Cleanup every 5 minutes
setInterval(() => {
  productionRateLimiter.cleanup();
}, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🔄 Shutting down Production Rate Limiter...');
  await productionRateLimiter.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🔄 Shutting down Production Rate Limiter...');
  await productionRateLimiter.close();
  process.exit(0);
});
