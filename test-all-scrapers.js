/**
 * Test script to run all scrapers and see what jobs they find
 */

import { execSync } from 'child_process';
import fs from 'fs';

// List of all scrapers to test
const scrapers = [
  'lever',
  'greenhouse', 
  'milkround',
  'workday',
  'jobteaser',
  'eures',
  'graduatejobs',
  'graduateland',
  'iagora',
  'smartrecruiters'
];

console.log('🧪 Testing all scrapers with IngestJob format...\n');

const results = [];

for (const scraper of scrapers) {
  console.log(`\n🔍 Testing ${scraper} scraper...`);
  
  try {
    // Run the scraper directly
    const output = execSync(`node scrapers/${scraper}.ts`, { 
      encoding: 'utf8',
      timeout: 30000, // 30 second timeout
      stdio: 'pipe'
    });
    
    console.log(`✅ ${scraper}: Success`);
    console.log(`📊 Output: ${output.slice(-200)}...`); // Last 200 chars
    
    results.push({
      scraper,
      status: 'success',
      output: output.slice(-200)
    });
    
  } catch (error) {
    console.log(`❌ ${scraper}: Failed`);
    console.log(`📊 Error: ${error.message}`);
    
    results.push({
      scraper,
      status: 'failed',
      error: error.message
    });
  }
  
  // Small delay between scrapers
  await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log('\n📋 SUMMARY:');
console.log('==========');

const successful = results.filter(r => r.status === 'success');
const failed = results.filter(r => r.status === 'failed');

console.log(`✅ Successful: ${successful.length}/${scrapers.length}`);
console.log(`❌ Failed: ${failed.length}/${scrapers.length}`);

if (failed.length > 0) {
  console.log('\n❌ Failed scrapers:');
  failed.forEach(r => {
    console.log(`  - ${r.scraper}: ${r.error}`);
  });
}

if (successful.length > 0) {
  console.log('\n✅ Successful scrapers:');
  successful.forEach(r => {
    console.log(`  - ${r.scraper}`);
  });
}

console.log('\n🎯 Next steps:');
console.log('1. Check successful scrapers for job output');
console.log('2. Fix any failed scrapers');
console.log('3. Run individual scraper tests for detailed output');
