import { createClient } from 'redis';
import { AdvancedMonitoringOracle } from './advancedMonitoring';
import { PerformanceMonitor } from './performanceMonitor';
import { dogstatsd } from './datadogMetrics';

// Enhanced cache configuration
const CACHE_CONFIG = {
  // TTL configuration
  TTL: {
    DEFAULT: 45 * 60 * 1000, // 45 minutes
    MIN: 30 * 60 * 1000,     // 30 minutes
    MAX: 60 * 60 * 1000,     // 60 minutes
    TARGET: 45 * 60 * 1000,  // 45 minutes target
    ADJUSTMENT_STEP: 15 * 60 * 1000, // 15 minutes
  },
  
  // Cache size configuration
  SIZE: {
    MAX_ENTRIES: 10000,
    WARM_ENTRIES: 5000, // Number of entries to persist
  },
  
  // Hit rate thresholds
  HIT_RATE: {
    TARGET: 0.6, // 60%
    MIN: 0.4,    // 40%
    MAX: 0.8,    // 80%
  },
  
  // Redis configuration
  REDIS: {
    KEY_PREFIX: 'jobping:cache:',
    META_KEY: 'jobping:cache:meta',
    STATS_KEY: 'jobping:cache:stats',
  }
};

// Cache entry interface
interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
}

// Cache metadata for persistence
interface CacheMeta {
  keys: string[];
  timestamps: { [key: string]: number };
  accessCounts: { [key: string]: number };
  lastAccessed: { [key: string]: number };
  ttl: number;
  version: string;
}

// Cache statistics
interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  sets: number;
  hitRate: number;
  avgTTL: number;
  size: number;
  lastReset: number;
}

// Enhanced LRU Cache with Redis persistence
export class EnhancedCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private redis: any;
  private stats: CacheStats;
  private currentTTL: number;
  private isInitialized: boolean = false;

  constructor(
    private name: string,
    private maxSize: number = CACHE_CONFIG.SIZE.MAX_ENTRIES,
    private defaultTTL: number = CACHE_CONFIG.TTL.DEFAULT
  ) {
    this.currentTTL = defaultTTL;
    // Note: AdvancedMonitoringOracle uses static methods only
    this.stats = this.initializeStats();
    // Skip Redis initialization in test mode
    if (process.env.NODE_ENV !== 'test') {
      // Lazy initialize Redis to avoid build-time issues
      this.initializeRedis().catch(console.error);
    }
  }

  private initializeStats(): CacheStats {
    return {
      hits: 0,
      misses: 0,
      evictions: 0,
      sets: 0,
      hitRate: 0,
      avgTTL: this.currentTTL,
      size: 0,
      lastReset: Date.now()
    };
  }

  private async initializeRedis() {
    try {
      this.redis = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
      });
      
      await this.redis.connect();
      console.log(`🔗 Redis connected for ${this.name} cache`);
      
      // Load warm cache data
      await this.loadWarmCache();
      
      this.isInitialized = true;
    } catch (error) {
      console.error(`❌ Redis connection failed for ${this.name} cache:`, error);
      // Continue with in-memory only
    }
  }

  // Get value from cache
  async get(key: string): Promise<T | null> {
    const startTime = Date.now();
    
    try {
      // Check in-memory cache first
      const entry = this.cache.get(key);
      
      if (entry) {
        // Check if expired
        if (Date.now() - entry.timestamp > entry.ttl) {
          this.cache.delete(key);
          this.stats.misses++;
          PerformanceMonitor.trackDuration(`cache_${this.name}_miss`, startTime);
          
          // Track cache miss for Datadog monitoring
          dogstatsd.increment('jobping.cache.misses', 1, [`cache:${this.name}`]);
          
          return null;
        }
        
        // Update access statistics
        entry.accessCount++;
        entry.lastAccessed = Date.now();
        
        this.stats.hits++;
        this.updateHitRate();
        PerformanceMonitor.trackDuration(`cache_${this.name}_hit`, startTime);
        
        // Track cache hit for Datadog monitoring
        dogstatsd.increment('jobping.cache.hits', 1, [`cache:${this.name}`]);
        
        return entry.value;
      }
      
      // Check Redis if available
      if (this.isInitialized && this.redis) {
        const redisKey = `${CACHE_CONFIG.REDIS.KEY_PREFIX}${this.name}:${key}`;
        const redisValue = await this.redis.get(redisKey);
        
        if (redisValue) {
          const entry: CacheEntry<T> = JSON.parse(redisValue);
          
          // Check if expired
          if (Date.now() - entry.timestamp > entry.ttl) {
            await this.redis.del(redisKey);
            this.stats.misses++;
            PerformanceMonitor.trackDuration(`cache_${this.name}_miss`, startTime);
            return null;
          }
          
          // Update access statistics
          entry.accessCount++;
          entry.lastAccessed = Date.now();
          
          // Store in memory cache
          this.setInMemory(key, entry.value, entry.ttl);
          
          // Update Redis
          await this.redis.set(redisKey, JSON.stringify(entry), { EX: Math.floor(entry.ttl / 1000) });
          
          this.stats.hits++;
          this.updateHitRate();
          PerformanceMonitor.trackDuration(`cache_${this.name}_hit`, startTime);
          
          return entry.value;
        }
      }
      
      this.stats.misses++;
      this.updateHitRate();
      PerformanceMonitor.trackDuration(`cache_${this.name}_miss`, startTime);
      
      return null;
      
    } catch (error) {
      console.error(`Error getting from ${this.name} cache:`, error);
      this.stats.misses++;
      return null;
    }
  }

  // Set value in cache
  async set(key: string, value: T, ttl?: number): Promise<void> {
    const startTime = Date.now();
    
    try {
      const entryTTL = ttl || this.currentTTL;
      
      // Set in memory cache
      this.setInMemory(key, value, entryTTL);
      
      // Set in Redis if available
      if (this.isInitialized && this.redis) {
        const redisKey = `${CACHE_CONFIG.REDIS.KEY_PREFIX}${this.name}:${key}`;
        const entry: CacheEntry<T> = {
          value,
          timestamp: Date.now(),
          ttl: entryTTL,
          accessCount: 1,
          lastAccessed: Date.now()
        };
        
        await this.redis.set(redisKey, JSON.stringify(entry), { EX: Math.floor(entryTTL / 1000) });
      }
      
      this.stats.sets++;
      PerformanceMonitor.trackDuration(`cache_${this.name}_set`, startTime);
      
    } catch (error) {
      console.error(`Error setting in ${this.name} cache:`, error);
    }
  }

  // Set value in memory cache only
  private setInMemory(key: string, value: T, ttl: number): void {
    // Check if cache is full
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }
    
    const entry: CacheEntry<T> = {
      value,
      timestamp: Date.now(),
      ttl,
      accessCount: 1,
      lastAccessed: Date.now()
    };
    
    this.cache.set(key, entry);
    this.stats.size = this.cache.size;
  }

  // Evict least recently used entry
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();
    
    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
      this.stats.size = this.cache.size;
    }
  }

  // Update hit rate and auto-adjust TTL
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    if (total > 0) {
      this.stats.hitRate = this.stats.hits / total;
      
      // Auto-adjust TTL based on hit rate
      this.autoAdjustTTL();
    }
  }

  // Auto-adjust TTL based on hit rate
  private autoAdjustTTL(): void {
    const { hitRate } = this.stats;
    const { TARGET, MIN, MAX, ADJUSTMENT_STEP } = CACHE_CONFIG.TTL;
    
    if (hitRate < CACHE_CONFIG.HIT_RATE.TARGET && this.currentTTL < MAX) {
      // Increase TTL if hit rate is low
      this.currentTTL = Math.min(MAX, this.currentTTL + ADJUSTMENT_STEP);
      console.log(`📈 ${this.name} cache: Increased TTL to ${this.currentTTL / 60000} minutes (hit rate: ${(hitRate * 100).toFixed(1)}%)`);
    } else if (hitRate > CACHE_CONFIG.HIT_RATE.MAX && this.currentTTL > MIN) {
      // Decrease TTL if hit rate is very high
      this.currentTTL = Math.max(MIN, this.currentTTL - ADJUSTMENT_STEP);
      console.log(`📉 ${this.name} cache: Decreased TTL to ${this.currentTTL / 60000} minutes (hit rate: ${(hitRate * 100).toFixed(1)}%)`);
    }
    
    this.stats.avgTTL = this.currentTTL;
  }

  // Load warm cache data from Redis
  private async loadWarmCache(): Promise<void> {
    if (!this.isInitialized || !this.redis) return;
    
    try {
      const metaKey = `${CACHE_CONFIG.REDIS.META_KEY}:${this.name}`;
      const metaData = await this.redis.get(metaKey);
      
      if (metaData) {
        const meta: CacheMeta = JSON.parse(metaData);
        
        // Load warm entries
        const warmKeys = meta.keys.slice(0, CACHE_CONFIG.SIZE.WARM_ENTRIES);
        
        for (const key of warmKeys) {
          const redisKey = `${CACHE_CONFIG.REDIS.KEY_PREFIX}${this.name}:${key}`;
          const entryData = await this.redis.get(redisKey);
          
          if (entryData) {
            const entry: CacheEntry<T> = JSON.parse(entryData);
            
            // Check if still valid
            if (Date.now() - entry.timestamp <= entry.ttl) {
              this.cache.set(key, entry);
            }
          }
        }
        
        console.log(`🔥 ${this.name} cache: Loaded ${this.cache.size} warm entries`);
      }
    } catch (error) {
      console.error(`Error loading warm cache for ${this.name}:`, error);
    }
  }

  // Persist cache metadata to Redis
  private async persistCacheMeta(): Promise<void> {
    if (!this.isInitialized || !this.redis) return;
    
    try {
      const meta: CacheMeta = {
        keys: Array.from(this.cache.keys()),
        timestamps: {},
        accessCounts: {},
        lastAccessed: {},
        ttl: this.currentTTL,
        version: '1.0'
      };
      
      // Collect metadata
      for (const [key, entry] of this.cache) {
        meta.timestamps[key] = entry.timestamp;
        meta.accessCounts[key] = entry.accessCount;
        meta.lastAccessed[key] = entry.lastAccessed;
      }
      
      const metaKey = `${CACHE_CONFIG.REDIS.META_KEY}:${this.name}`;
      await this.redis.set(metaKey, JSON.stringify(meta), { EX: 24 * 60 * 60 }); // 24 hours
      
    } catch (error) {
      console.error(`Error persisting cache meta for ${this.name}:`, error);
    }
  }

  // Get cache statistics
  getStats(): CacheStats {
    return { ...this.stats };
  }

  // Clear cache
  async clear(): Promise<void> {
    this.cache.clear();
    this.stats = this.initializeStats();
    
    if (this.isInitialized && this.redis) {
      // Clear Redis keys for this cache
      const pattern = `${CACHE_CONFIG.REDIS.KEY_PREFIX}${this.name}:*`;
      const keys = await this.redis.keys(pattern);
      
      if (keys.length > 0) {
        await this.redis.del(keys);
      }
    }
    
    console.log(`🧹 ${this.name} cache cleared`);
  }

  // Get cache size
  size(): number {
    return this.cache.size;
  }

  // Check if key exists
  has(key: string): boolean {
    return this.cache.has(key);
  }

  // Delete specific key
  async delete(key: string): Promise<boolean> {
    const deleted = this.cache.delete(key);
    
    if (this.isInitialized && this.redis) {
      const redisKey = `${CACHE_CONFIG.REDIS.KEY_PREFIX}${this.name}:${key}`;
      await this.redis.del(redisKey);
    }
    
    if (deleted) {
      this.stats.size = this.cache.size;
    }
    
    return deleted;
  }

  // Get all keys
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  // Get all values
  values(): T[] {
    return Array.from(this.cache.values()).map(entry => entry.value);
  }

  // Get all entries
  entries(): [string, T][] {
    return Array.from(this.cache.entries()).map(([key, entry]) => [key, entry.value]);
  }

  // Periodic cleanup and persistence
  async startMaintenance(): Promise<void> {
    setInterval(async () => {
      // Clean up expired entries
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (now - entry.timestamp > entry.ttl) {
          this.cache.delete(key);
        }
      }
      
      // Persist cache metadata
      await this.persistCacheMeta();
      
      // Update monitoring (commented out - method not available)
      // this.monitoringOracle.updateCacheMetrics(this.name, this.stats);
      
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  // Close cache and cleanup
  async close(): Promise<void> {
    await this.persistCacheMeta();
    
    if (this.redis) {
      await this.redis.quit();
    }
    
    this.cache.clear();
    console.log(`🔒 ${this.name} cache closed`);
  }
}

// Enhanced AI Matching Cache with Redis persistence
export class EnhancedAIMatchingCache {
  private static instance: EnhancedAIMatchingCache;
  private cache: EnhancedCache<any[]>;

  private constructor() {
    this.cache = new EnhancedCache<any[]>('ai-matching', CACHE_CONFIG.SIZE.MAX_ENTRIES, CACHE_CONFIG.TTL.DEFAULT);
    // Note: AdvancedMonitoringOracle uses static methods only
    this.cache.startMaintenance();
  }

  static getInstance(): EnhancedAIMatchingCache {
    if (!EnhancedAIMatchingCache.instance) {
      EnhancedAIMatchingCache.instance = new EnhancedAIMatchingCache();
    }
    return EnhancedAIMatchingCache.instance;
  }

  // Generate user cluster key
  static generateUserClusterKey(users: any[]): string {
    const signature = users
      .map(u => `${u.professional_expertise}-${u.entry_level_preference}-${u.target_cities?.split(',')[0] || 'unknown'}`)
      .sort()
      .join('|');
    
    return `ai_cluster:${require('crypto').createHash('md5').update(signature).digest('hex').slice(0, 12)}`;
  }

  // Get cached matches
  async getCachedMatches(userCluster: any[]): Promise<any[] | null> {
    const key = EnhancedAIMatchingCache.generateUserClusterKey(userCluster);
    const cached = await this.cache.get(key);
    
    if (cached) {
      console.log(`🎯 Enhanced cache hit for cluster of ${userCluster.length} users`);
    }
    
    return cached || null;
  }

  // Set cached matches
  async setCachedMatches(userCluster: any[], matches: any[]): Promise<void> {
    const key = EnhancedAIMatchingCache.generateUserClusterKey(userCluster);
    await this.cache.set(key, matches);
    
    console.log(`💾 Enhanced cache set for ${userCluster.length} users (cache size: ${this.cache.size()})`);
  }

  // Clear cache
  async clearCache(): Promise<void> {
    await this.cache.clear();
    console.log('🧹 Enhanced AI matching cache cleared');
  }

  // Get cache statistics
  getStats() {
    return this.cache.getStats();
  }

  // Close cache
  async close(): Promise<void> {
    await this.cache.close();
  }
}

// Export singleton instance
export const enhancedAIMatchingCache = EnhancedAIMatchingCache.getInstance();
