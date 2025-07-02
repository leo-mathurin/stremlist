#!/usr/bin/env node

/**
 * Test script for getImdbWatchlist function
 * 
 * This script tests the HTML-based watchlist extraction functionality
 * including private list detection, empty lists, and error handling.
 */

const { getImdbWatchlist } = require('./fetch_watchlist');

async function testGetImdbWatchlist() {
    console.log('=== Testing getImdbWatchlist Function ===\n');
    
    // Test 1: Valid user ID (Léo's watchlist)
    console.log('1. Testing with valid user ID (ur195879360)...');
    try {
        const startTime = Date.now();
        const result = await getImdbWatchlist('ur195879360');
        const endTime = Date.now();
        
        console.log('✓ Success!');
        console.log(`  - Items found: ${result.length}`);
        console.log(`  - Time taken: ${endTime - startTime}ms`);
        
        // Show first item details
        if (result.length > 0) {
            const firstItem = result[0];
            const title = firstItem.listItem?.titleText?.text;
            const year = firstItem.listItem?.releaseYear?.year;
            const type = firstItem.listItem?.titleType?.text;
            console.log(`  - First item: ${title} (${year}) - ${type}`);
        }
        
        // Validate data structure
        const hasValidStructure = result[0] && 
            result[0].listItem && 
            result[0].listItem.titleText;
        console.log(`  - Data structure valid: ${hasValidStructure ? 'YES' : 'NO'}`);
        
    } catch (error) {
        console.log('❌ Failed:', error.message);
    }
    
    // Test 2: Invalid user ID
    console.log('\n2. Testing with invalid user ID...');
    try {
        await getImdbWatchlist('invalid_user_123');
        console.log('⚠️  Expected error but got success');
    } catch (error) {
        console.log('✓ Correctly handled invalid user ID');
        console.log(`  - Error: ${error.message}`);
    }
    
    // Test 3: Non-existent user ID
    console.log('\n3. Testing with non-existent user ID...');
    try {
        await getImdbWatchlist('ur999999999');
        console.log('⚠️  Expected error but got success');
    } catch (error) {
        console.log('✓ Correctly handled non-existent user ID');
        console.log(`  - Error: ${error.message}`);
    }
    
    // Test 4: Public but empty watchlist
    console.log('\n4. Testing with public empty watchlist (ur198342247)...');
    try {
        const result = await getImdbWatchlist('ur198342247');
        console.log('✓ Public empty list accessed successfully');
        console.log(`  - Items found: ${result ? result.length : 'null'}`);
    } catch (error) {
        console.log('❌ Failed to access public empty list:', error.message);
    }
    
    // Test 5: Private watchlist (updated detection)
    console.log('\n5. Testing with private watchlist (ur47960495)...');
    try {
        const result = await getImdbWatchlist('ur47960495');
        console.log('⚠️  Expected private list error but got result');
        console.log(`  - Items found: ${result ? result.length : 'null'}`);
    } catch (error) {
        if (error.message.includes('private')) {
            console.log('✓ Correctly detected private watchlist');
            console.log(`  - Error: ${error.message}`);
        } else {
            console.log('❌ Got different error than expected');
            console.log(`  - Error: ${error.message}`);
        }
    }
    
    console.log('\n=== Test Complete ===');
}

// Run the test
if (require.main === module) {
    testGetImdbWatchlist().catch(console.error);
}

module.exports = { testGetImdbWatchlist }; 