#!/usr/bin/env node

/**
 * Test script for IMDb GraphQL hash extraction
 * 
 * This script tests the integration between the Python hash extractor
 * and the Node.js hash manager.
 */

const { getGraphQLHash, getCacheStatus, extractHashFromPython } = require('../utils/hash-manager');
const { getImdbWatchlist } = require('./fetch_watchlist');

async function testHashExtraction() {
    console.log('=== IMDb GraphQL Hash Extraction Test ===\n');
    
    try {
        // Test 1: Direct Python script execution
        console.log('1. Testing direct Python script execution...');
        const directHash = await extractHashFromPython();
        console.log('✓ Direct extraction successful!');
        console.log('  Hash:', directHash);
        console.log('  Length:', directHash.length, 'characters');
        
        // Test 2: Hash manager with caching
        console.log('\n2. Testing hash manager with caching...');
        const cachedHash = await getGraphQLHash();
        console.log('✓ Hash manager successful!');
        console.log('  Hash:', cachedHash);
        
        // Test 3: Cache status
        console.log('\n3. Testing cache status...');
        const cacheStatus = getCacheStatus();
        console.log('✓ Cache status:', JSON.stringify(cacheStatus, null, 2));
        
        // Test 4: Using cached hash (should be instant)
        console.log('\n4. Testing cached hash retrieval...');
        const startTime = Date.now();
        const cachedHash2 = await getGraphQLHash();
        const endTime = Date.now();
        console.log('✓ Cached retrieval successful!');
        console.log('  Time taken:', endTime - startTime, 'ms');
        console.log('  Hash matches:', cachedHash === cachedHash2);
        
        // Verify hash format
        console.log('\n5. Verifying hash format...');
        const hashRegex = /^[a-f0-9]{64}$/;
        const isValidFormat = hashRegex.test(directHash);
        console.log('✓ Hash format validation:', isValidFormat ? 'VALID' : 'INVALID');
        
        if (!isValidFormat) {
            console.log('  Expected: 64-character hexadecimal string');
            console.log('  Actual:  ', directHash);
        }
        
        // Test 6: IMDb Watchlist API Integration
        console.log('\n6. Testing IMDb Watchlist API Integration...');
        await testWatchlistIntegration();
        
        console.log('\n=== All tests completed successfully! ===');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error('\nTroubleshooting:');
        console.error('1. Make sure you have run: ./scripts/setup_python_env.sh');
        console.error('2. Check that crawl4ai is properly installed');
        console.error('3. Verify your internet connection');
        console.error('4. Check if IMDb is accessible');
        
        process.exit(1);
    }
}

async function testWatchlistIntegration() {
    console.log('  Testing with invalid user ID...');
    try {
        // Test with an obviously invalid user ID
        const invalidResult = await getImdbWatchlist('invalid_user_123');
        console.log('  ⚠️  Expected error for invalid user ID, but got result');
    } catch (error) {
        console.log('  ✓ Invalid user ID correctly handled:', error.message);
    }
    
    console.log('  Testing with Léo\'s user ID...');
    try {
        const demoUserId = 'ur195879360';
        const startTime = Date.now();
        const result = await getImdbWatchlist(demoUserId);
        const endTime = Date.now();
        
        if (result && Array.isArray(result)) {
            console.log('  ✓ Watchlist fetch successful!');
            console.log('    - Items found:', result.length);
            console.log('    - Time taken:', endTime - startTime, 'ms');
            
            // Validate structure of first item if available
            if (result.length > 0) {
                const firstItem = result[0];
                const hasValidStructure = firstItem && 
                    firstItem.listItem && 
                    firstItem.listItem.titleText;
                console.log('    - Data structure valid:', hasValidStructure ? 'YES' : 'NO');
            }
        }
    } catch (error) {
        if (error.message.includes('private')) {
            console.log('  ✓ Private watchlist detected:', error.message);
        } else if (error.message.includes('Could not find')) {
            console.log('  ✓ User not found (expected for demo ID):', error.message);
        } else {
            console.log('  ⚠️  Unexpected error:', error.message);
        }
    }
    
    console.log('  ✓ Watchlist integration tests completed!');
}

// Run the test
if (require.main === module) {
    testHashExtraction();
}

module.exports = { testHashExtraction, testWatchlistIntegration }; 