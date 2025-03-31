/**
 * Jest configuration file
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'database/**/*.js',
    'scripts/**/*.js',
    'addon.js'
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    'jest.config.js'
  ],
  testTimeout: 30000,
  // Set up global test environment variables
  globals: {
    // Add any global test variables here
    'NODE_ENV': 'test'
  },
  moduleFileExtensions: ['js', 'json'],
  setupFiles: ['./tests/setup.js']
}; 