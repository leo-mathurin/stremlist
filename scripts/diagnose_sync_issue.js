#!/usr/bin/env node

/**
 * Comprehensive Sync Issue Diagnostic Script
 * Identifies the root cause of rapid watchlist fetching
 */

const db = require('../database');

async function diagnoseSyncIssue() {
    console.log('🔍 SYNC ISSUE DIAGNOSTIC');
    console.log('==============================');
    
    try {
        // Initialize database connection
        await db.initialize();
        
        // 1. Check current sync intervals and timers
        console.log('\n📊 1. SYNC CONFIGURATION CHECK:');
        const constants = require('../constants');
        console.log('  SYNC_INTERVAL:', constants.SYNC_INTERVAL_MS / 1000 / 60, 'minutes');
        console.log('  CACHE_TTL:', constants.CACHE_TTL_MS / 1000 / 60, 'minutes');
        console.log('  RATE_LIMIT_REQUESTS:', constants.RATE_LIMIT_REQUESTS);
        console.log('  RATE_LIMIT_INTERVAL:', constants.RATE_LIMIT_INTERVAL / 1000, 'seconds');
        
        // 2. Get background sync status
        console.log('\n🔧 2. BACKGROUND SYNC STATUS:');
        const bgStatus = await db.getBackgroundSyncStatus();
        console.log('  Initialized:', bgStatus.isInitialized);
        
        if (bgStatus.components) {
            console.log('  Queue initialized:', bgStatus.components.queue?.initialized);
            console.log('  Worker initialized:', bgStatus.components.worker?.initialized);
            console.log('  Rate limiter initialized:', bgStatus.components.rateLimiter?.initialized);
            
            if (bgStatus.components.worker?.stats) {
                console.log('  Worker concurrency:', bgStatus.components.worker.stats.concurrency);
                console.log('  Active workers:', bgStatus.components.worker.stats.active);
            }
        }
        
        // 3. Check queue in detail
        console.log('\n📈 3. DETAILED QUEUE ANALYSIS:');
        if (bgStatus.components?.queue?.stats) {
            const stats = bgStatus.components.queue.stats;
            console.log('  Waiting jobs:', stats.waitingCount);
            console.log('  Active jobs:', stats.activeCount);
            console.log('  Delayed jobs:', stats.delayedCount);
            console.log('  Failed jobs:', stats.failedCount);
            console.log('  Completed jobs:', stats.completedCount);
            
            // Check if there are active or delayed jobs
            if (stats.activeCount > 0 || stats.delayedCount > 0) {
                console.log('  ⚠️ WARNING: Active or delayed jobs found!');
            }
        }
        
        // 4. Check for stuck jobs by examining Redis directly
        console.log('\n🔍 4. REDIS QUEUE INSPECTION:');
        try {
            const { getSyncQueue } = require('../database/job-queue');
            const queue = getSyncQueue();
            
            if (queue) {
                const waiting = await queue.getWaiting();
                const active = await queue.getActive();
                const delayed = await queue.getDelayed();
                
                console.log('  Direct queue check:');
                console.log('    Waiting:', waiting.length);
                console.log('    Active:', active.length);
                console.log('    Delayed:', delayed.length);
                
                // Show details of active jobs
                if (active.length > 0) {
                    console.log('  🚨 ACTIVE JOBS DETAILS:');
                    for (const job of active.slice(0, 3)) {
                        console.log(`    Job ${job.id}: User ${job.data.userId}, Started: ${new Date(job.processedOn).toISOString()}`);
                    }
                }
                
                // Show details of delayed jobs
                if (delayed.length > 0) {
                    console.log('  ⏰ DELAYED JOBS DETAILS:');
                    for (const job of delayed.slice(0, 5)) {
                        const delayUntil = new Date(job.opts.delay + job.timestamp);
                        console.log(`    Job ${job.id}: User ${job.data.userId}, Execute at: ${delayUntil.toISOString()}`);
                    }
                }
            }
        } catch (error) {
            console.log('  Error accessing queue directly:', error.message);
        }
        
        // 5. Check rate limiter status
        console.log('\n⏱️ 5. RATE LIMITER ANALYSIS:');
        const canMakeRequest = await db.canMakeImdbRequest();
        console.log('  Can make request now:', canMakeRequest);
        
        // 6. Check recent logs for sync patterns
        console.log('\n📝 6. RECENT ACTIVITY CHECK:');
        const activeUsers = await db.getActiveUsers();
        console.log('  Total active users:', activeUsers.length);
        
        // 7. Memory check for running intervals
        console.log('\n🧠 7. MEMORY/PROCESS CHECK:');
        console.log('  Process uptime:', Math.round(process.uptime()), 'seconds');
        console.log('  Memory usage:', Math.round(process.memoryUsage().heapUsed / 1024 / 1024), 'MB');
        
        // 8. Check if old sync is still running
        console.log('\n🔄 8. SYNC INTERVAL CHECK:');
        console.log('  NOTE: Check application logs for STAGGERED SYNC or old sync patterns');
        console.log('  Expected: "STAGGERED SYNC STARTING" every 12 hours');
        console.log('  Problem: Frequent sync logs or job creation');
        
        // 9. Recommendations
        console.log('\n💡 9. DIAGNOSTIC RECOMMENDATIONS:');
        
        if (bgStatus.components?.queue?.stats?.activeCount > 0) {
            console.log('  🚨 ISSUE: Active jobs are running - force kill them');
            console.log('     FIX: docker exec stremlist-app node -e "');
            console.log('          const db = require(\"./database\");');
            console.log('          (async () => {');
            console.log('            const { getSyncQueue } = require(\"./database/job-queue\");');
            console.log('            const queue = getSyncQueue();');
            console.log('            if (queue) await queue.clean(0, \"active\", 100);');
            console.log('            process.exit(0);');
            console.log('          })();');
            console.log('        "');
        }
        
        if (bgStatus.components?.queue?.stats?.delayedCount > 0) {
            console.log('  ⚠️ ISSUE: Delayed jobs still exist - remove them');
            console.log('     FIX: Run cleanup script again with force removal');
        }
        
        if (bgStatus.components?.worker?.stats?.concurrency > 1) {
            console.log('  ⚠️ ISSUE: Worker concurrency too high for rate limiting');
            console.log('     FIX: Reduce worker concurrency to 1 in environment variables');
        }
        
        console.log('\n🎯 NEXT STEPS:');
        console.log('  1. Check application logs: docker logs stremlist-app | tail -50');
        console.log('  2. Look for STAGGERED SYNC logs vs old sync patterns');
        console.log('  3. Force remove stuck jobs if found');
        console.log('  4. Reduce worker concurrency if needed');
        
    } catch (error) {
        console.error('💥 Diagnostic error:', error);
    } finally {
        await db.closeConnections();
        process.exit(0);
    }
}

diagnoseSyncIssue(); 