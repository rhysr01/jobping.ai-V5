const nextJest = require('next/jest')

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files
  dir: './',
})

// Add any custom config to be passed to Jest
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  collectCoverageFrom: [
    'app/**/*.{js,jsx,ts,tsx}',
    'Utils/**/*.{js,jsx,ts,tsx}',
    'scrapers/**/*.{js,jsx,ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  testMatch: [
    '**/__tests__/**/*.(ts|tsx|js)',
    '**/*.(test|spec).(ts|tsx|js)',
  ],
  transformIgnorePatterns: [
    'node_modules/(?!(cheerio|parse5|domhandler|domutils|entities|nth-check|boolbase|css-select|css-what|htmlparser2|readable-stream|string_decoder|inherits|isarray|core-util-is|buffer|process|util|events|stream|path|os|fs|crypto|url|querystring|punycode|http|https|zlib|assert|constants|domain|dns|net|tls|tty|v8|vm|worker_threads|child_process|cluster|dgram|dns|fs|http|https|net|os|path|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)/)',
  ],
  testEnvironmentOptions: {
    customExportConditions: ['node', 'node-addons'],
  },
}

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
module.exports = createJestConfig(customJestConfig)
