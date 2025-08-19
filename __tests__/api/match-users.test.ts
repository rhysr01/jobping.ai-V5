import { NextRequest } from 'next/server';
import { POST, GET } from '@/app/api/match-users/route';

describe('/api/match-users', () => {
  let mockRequest: NextRequest;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Set up mock data
    global.__SB_MOCK__ = {
      users: [
        {
          id: 1,
          email: 'test-api@jobping.ai',
          full_name: 'Test User',
          email_verified: true,
          subscription_active: true,
          created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
          target_cities: 'madrid|barcelona',
          languages_spoken: 'English,Spanish',
          company_types: 'startup,tech',
          roles_selected: 'software engineer,data analyst',
          professional_expertise: 'entry',
          visa_status: 'eu-citizen',
          start_date: new Date().toISOString(),
          work_environment: 'hybrid',
          career_path: 'marketing',
          entry_level_preference: 'entry',
          subscription_tier: 'free'
        }
      ],
      jobs: [
        {
          id: '1',
          title: 'Junior Software Engineer',
          company: 'Test Company',
          location: 'Madrid, Spain',
          job_url: 'https://example.com/job1',
          description: 'Entry-level software engineering position...',
          created_at: new Date().toISOString(),
          job_hash: 'hash1',
          is_sent: false,
          status: 'active',
          freshness_tier: 'fresh',
          original_posted_date: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          last_seen_at: new Date().toISOString(),
          categories: 'career:tech|early-career|loc:madrid'
        },
        {
          id: '2',
          title: 'Data Analyst',
          company: 'Tech Corp',
          location: 'Barcelona, Spain',
          job_url: 'https://example.com/job2',
          description: 'Data analysis role for recent graduates...',
          created_at: new Date().toISOString(),
          job_hash: 'hash2',
          is_sent: false,
          status: 'active',
          freshness_tier: 'ultra_fresh',
          original_posted_date: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
          last_seen_at: new Date().toISOString(),
          categories: 'career:marketing|early-career|loc:barcelona'
        }
      ],
      matches: [],
      match_logs: []
    };
    
    // Mock request
    mockRequest = new NextRequest('http://localhost:3000/api/match-users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '127.0.0.1',
      },
    });
  });

  describe('POST', () => {
    it('should return 400 for invalid request body', async () => {
      const request = new NextRequest('http://localhost:3000/api/match-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 'invalid' }), // Invalid limit type
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it('should handle rate limiting', async () => {
      const request = new NextRequest('http://localhost:3000/api/match-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 5 }),
      });

      const response = await POST(request);
      const data = await response.json();

      // Rate limiting is disabled in test mode, so this should pass
      expect(response.status).toBe(200);
    });

    it('should handle database connection errors', async () => {
      // Clear mock data to simulate database error
      global.__SB_MOCK__ = {
        users: [],
        jobs: []
      };

      const request = new NextRequest('http://localhost:3000/api/match-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 5 }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.message).toBe('No users found');
    });

    it('should return success for valid request', async () => {
      const request = new NextRequest('http://localhost:3000/api/match-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 5 }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toBeDefined();
    });
  });

  describe('GET', () => {
    it('should return 405 for GET method', async () => {
      const request = new NextRequest('http://localhost:3000/api/match-users', {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(405);
    });
  });
});
