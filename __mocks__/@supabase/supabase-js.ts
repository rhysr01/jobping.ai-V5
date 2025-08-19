// Mock Supabase client for testing
// Supports all chainable methods used in the API routes

interface MockResponse<T = any> {
  data: T;
  error: any;
}

interface FilterBuilder {
  select(columns?: string): FilterBuilder;
  eq(column: string, value: any): FilterBuilder;
  gte(column: string, value: any): FilterBuilder;
  lte(column: string, value: any): FilterBuilder;
  lt(column: string, value: any): FilterBuilder;
  in(column: string, values: any[]): FilterBuilder;
  is(column: string, value: any): FilterBuilder;
  order(column: string, options?: { ascending?: boolean }): FilterBuilder;
  limit(count: number): Promise<MockResponse>;
  single(): Promise<MockResponse>;
  upsert(data: any): Promise<MockResponse>;
  insert(data: any): Promise<MockResponse>;
  update(data: any): Promise<MockResponse>;
  delete(): Promise<MockResponse>;
}

interface MockSupabaseClient {
  from(table: string): FilterBuilder;
  auth: {
    signUp: (data: any) => Promise<MockResponse>;
    signIn: (data: any) => Promise<MockResponse>;
  };
}

// Global mock data store
declare global {
  var __SB_MOCK__: {
    users?: any[];
    jobs?: any[];
    matches?: any[];
    match_logs?: any[];
    [key: string]: any[];
  };
}

// Initialize global mock data if not exists
if (!global.__SB_MOCK__) {
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
}

class MockFilterBuilder implements FilterBuilder {
  private table: string;
  private filters: Array<{ type: string; column: string; value: any }> = [];
  private selectedColumns: string = '*';
  private orderBy?: { column: string; ascending: boolean };
  private limitCount?: number;
  private isSingle: boolean = false;

  constructor(table: string) {
    this.table = table;
  }

  select(columns: string = '*'): FilterBuilder {
    this.selectedColumns = columns;
    return this;
  }

  eq(column: string, value: any): FilterBuilder {
    this.filters.push({ type: 'eq', column, value });
    return this;
  }

  gte(column: string, value: any): FilterBuilder {
    this.filters.push({ type: 'gte', column, value });
    return this;
  }

  lte(column: string, value: any): FilterBuilder {
    this.filters.push({ type: 'lte', column, value });
    return this;
  }

  lt(column: string, value: any): FilterBuilder {
    this.filters.push({ type: 'lt', column, value });
    return this;
  }

  in(column: string, values: any[]): FilterBuilder {
    this.filters.push({ type: 'in', column, value: values });
    return this;
  }

  is(column: string, value: any): FilterBuilder {
    this.filters.push({ type: 'is', column, value });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): FilterBuilder {
    this.orderBy = { column, ascending: options.ascending !== false };
    return this;
  }

  limit(count: number): Promise<MockResponse> {
    this.limitCount = count;
    return this.execute();
  }

  single(): Promise<MockResponse> {
    this.isSingle = true;
    return this.execute();
  }

  upsert(data: any): Promise<MockResponse> {
    return this.executeUpsert(data);
  }

  insert(data: any): Promise<MockResponse> {
    return this.executeInsert(data);
  }

  update(data: any): Promise<MockResponse> {
    return this.executeUpdate(data);
  }

  delete(): Promise<MockResponse> {
    return this.executeDelete();
  }

  private async execute(): Promise<MockResponse> {
    const tableData = global.__SB_MOCK__[this.table] || [];
    let filteredData = [...tableData];

    // Debug logging in test mode
    if (process.env.NODE_ENV === 'test') {
      console.log(`Mock query for table ${this.table}:`, {
        filters: this.filters,
        tableData: tableData.length,
        orderBy: this.orderBy,
        limitCount: this.limitCount,
        isSingle: this.isSingle
      });
    }

    // Apply filters
    for (const filter of this.filters) {
      filteredData = filteredData.filter(item => {
        const itemValue = item[filter.column];
        
        switch (filter.type) {
          case 'eq':
            return itemValue === filter.value;
          case 'gte':
            return itemValue >= filter.value;
          case 'lte':
            return itemValue <= filter.value;
          case 'lt':
            return itemValue < filter.value;
          case 'in':
            return Array.isArray(filter.value) && filter.value.includes(itemValue);
          case 'is':
            return itemValue === filter.value;
          default:
            return true;
        }
      });
    }

    // Apply ordering
    if (this.orderBy) {
      filteredData.sort((a, b) => {
        const aVal = a[this.orderBy!.column];
        const bVal = b[this.orderBy!.column];
        
        if (aVal < bVal) return this.orderBy!.ascending ? -1 : 1;
        if (aVal > bVal) return this.orderBy!.ascending ? 1 : -1;
        return 0;
      });
    }

    // Apply limit
    if (this.limitCount !== undefined) {
      filteredData = filteredData.slice(0, this.limitCount);
    }

    // Return single or array
    if (this.isSingle) {
      return {
        data: filteredData.length > 0 ? filteredData[0] : null,
        error: null
      };
    }

    return {
      data: filteredData,
      error: null
    };
  }

  private async executeUpsert(data: any): Promise<MockResponse> {
    const tableData = global.__SB_MOCK__[this.table] || [];
    
    if (Array.isArray(data)) {
      // Handle array upsert
      for (const item of data) {
        const existingIndex = tableData.findIndex(existing => 
          existing.job_hash === item.job_hash || existing.id === item.id
        );
        
        if (existingIndex >= 0) {
          tableData[existingIndex] = { ...tableData[existingIndex], ...item };
        } else {
          tableData.push(item);
        }
      }
    } else {
      // Handle single item upsert
      const existingIndex = tableData.findIndex(existing => 
        existing.job_hash === data.job_hash || existing.id === data.id
      );
      
      if (existingIndex >= 0) {
        tableData[existingIndex] = { ...tableData[existingIndex], ...data };
      } else {
        tableData.push(data);
      }
    }

    global.__SB_MOCK__[this.table] = tableData;
    
    return {
      data: null,
      error: null
    };
  }

  private async executeInsert(data: any): Promise<MockResponse> {
    const tableData = global.__SB_MOCK__[this.table] || [];
    
    if (Array.isArray(data)) {
      tableData.push(...data);
    } else {
      tableData.push(data);
    }

    global.__SB_MOCK__[this.table] = tableData;
    
    return {
      data: null,
      error: null
    };
  }

  private async executeUpdate(data: any): Promise<MockResponse> {
    // For simplicity, just return success
    return {
      data: null,
      error: null
    };
  }

  private async executeDelete(): Promise<MockResponse> {
    // For simplicity, just return success
    return {
      data: null,
      error: null
    };
  }
}

export function createClient(url: string, key: string, options?: any): MockSupabaseClient {
  return {
    from(table: string): FilterBuilder {
      return new MockFilterBuilder(table);
    },
    auth: {
      signUp: jest.fn(() => Promise.resolve({ data: null, error: null })),
      signIn: jest.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
}