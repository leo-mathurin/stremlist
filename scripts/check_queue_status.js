#!/usr/bin/env node

/**
 * Queue Status Checker Script
 * Shows current queue statistics and job details
 */

const db = require('../database');

async function checkQueueStatus() {
    console.log('📊 Checking Queue Status...');
    
    try {
        // Initialize database connection
        console.log('📡 Connecting to database...');
        const success = await db.initialize();
        if (!success) {
            console.error('❌ Failed to initialize database connection');
            process.exit(1);
        }
        
        // Get background sync status
        const bgStatus = await db.getBackgroundSyncStatus();
        console.log('🔧 Background Sync Status:');
        console.log('  Initialized:', bgStatus.isInitialized);
        
        if (bgStatus.isInitialized && bgStatus.components) {
            console.log('  Queue:', bgStatus.components.queue?.initialized || false);
            console.log('  Worker:', bgStatus.components.worker?.initialized || false);
            console.log('  Rate Limiter:', bgStatus.components.rateLimiter?.initialized || false);
            
            // Show queue stats
            if (bgStatus.components.queue?.stats) {
                const stats = bgStatus.components.queue.stats;
                console.log('\n📈 Current Queue Statistics:');
                console.log('  Waiting Jobs:', stats.waitingCount || 0);
                console.log('  Active Jobs:', stats.activeCount || 0);
                console.log('  Delayed Jobs:', stats.delayedCount || 0);
                console.log('  Completed Jobs:', stats.completedCount || 0);
                console.log('  Failed Jobs:', stats.failedCount || 0);
                
                const totalPending = (stats.waitingCount || 0) + (stats.activeCount || 0) + (stats.delayedCount || 0);
                console.log('  Total Pending:', totalPending);
                
                if (totalPending > 50) {
                    console.log('\n⚠️ WARNING: High number of pending jobs detected!');
                    console.log('   This suggests old bulk sync jobs are still in the queue.');
                    console.log('   Consider running the cleanup script: ./cleanup_queue.sh');
                }
            }
            
            // Show rate limiter stats
            if (bgStatus.components.rateLimiter?.stats) {
                const rlStats = bgStatus.components.rateLimiter.stats;
                console.log('\n⏱️ Rate Limiter Status:');
                console.log('  Available Tokens:', rlStats.availableTokens || 'Unknown');
                console.log('  Next Refill:', rlStats.nextRefill ? new Date(rlStats.nextRefill).toISOString() : 'Unknown');
            }
        }
        
        // Get active users
        const activeUsers = await db.getActiveUsers();
        console.log(`\n👥 Active Users: ${activeUsers.length}`);
        
        if (activeUsers.length > 0) {
            console.log('   Sample users:', activeUsers.slice(0, 5).join(', '));
            if (activeUsers.length > 5) {
                console.log(`   ... and ${activeUsers.length - 5} more`);
            }
        }
        
        // Show Redis status
        const isRedisActive = await db.isRedisActive();
        console.log('\n🔗 Storage Backend:');
        console.log('  Redis Active:', isRedisActive);
        console.log('  Backend:', isRedisActive ? 'Redis' : 'Memory');
        
        if (isRedisActive) {
            const connections = await db.getActiveConnectionsCount();
            console.log('  Active Connections:', connections);
        }
        
    } catch (error) {
        console.error('💥 Error checking queue status:', error);
        process.exit(1);
    } finally {
        // Close database connections
        await db.closeConnections();
        console.log('\n✅ Status check completed');
        process.exit(0);
    }
}

// Handle script arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log(`
📊 Queue Status Checker

Usage: node scripts/check_queue_status.js [options]

Options:
  --help, -h    Show this help message

This script will:
1. Connect to the database
2. Show background sync system status
3. Display current queue statistics
4. Show active users count
5. Display Redis/storage status
`);
    process.exit(0);
}

checkQueueStatus(); 