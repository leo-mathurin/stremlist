#!/usr/bin/env python3
"""
IMDb GraphQL Hash Extractor

This script uses crawl4ai Docker client to visit an IMDb watchlist page and extract the current
GraphQL persisted query hash from network requests.
"""

import asyncio
import json
import sys
import re
import os
from urllib.parse import unquote
from crawl4ai.docker_client import Crawl4aiDockerClient
from crawl4ai import BrowserConfig, CrawlerRunConfig, CacheMode


def get_crawl4ai_server_url():
    """
    Extract the Crawl4AI Docker server URL from constants.js
    
    Returns:
        str: The Docker server URL
    
    Raises:
        Exception: If the URL cannot be found or read
    """
    try:
        # Get the path to constants.js (one level up from scripts directory)
        script_dir = os.path.dirname(os.path.abspath(__file__))
        constants_path = os.path.join(script_dir, '..', 'constants.js')
        
        with open(constants_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Look for the CRAWL4AI_DOCKER_SERVER constant
        match = re.search(r"const CRAWL4AI_DOCKER_SERVER\s*=\s*['\"]([^'\"]+)['\"]", content)
        if match:
            return match.group(1)
        
        # Fallback: look in the module.exports section
        match = re.search(r"CRAWL4AI_DOCKER_SERVER[,\s]*", content)
        if match:
            # If found in exports, look for the definition above
            match = re.search(r"['\"]([^'\"]*129\.151\.250\.86:11235[^'\"]*)['\"]", content)
            if match:
                return match.group(1)
        
        raise Exception("CRAWL4AI_DOCKER_SERVER not found in constants.js")
        
    except FileNotFoundError:
        raise Exception("constants.js file not found")
    except Exception as e:
        raise Exception(f"Error reading constants.js: {str(e)}")


async def extract_imdb_graphql_hash(test_user_id="ur195879360"):
    """
    Extract the GraphQL hash from IMDb watchlist page network requests.
    
    Args:
        test_user_id (str): A test IMDb user ID to visit (doesn't need to be real)
    
    Returns:
        str: The extracted SHA256 hash
    
    Raises:
        Exception: If hash extraction fails
    """
    # IMDb watchlist URL - we'll use a generic user ID to trigger the GraphQL calls
    url = f"https://www.imdb.com/user/{test_user_id}/watchlist"
    
    # Get Crawl4AI Docker server URL from constants
    try:
        docker_server_url = get_crawl4ai_server_url()
        print(f"Using Crawl4AI server: {docker_server_url}")
    except Exception as e:
        print(f"Error getting server URL from constants: {e}")
        raise
    
    try:
        async with Crawl4aiDockerClient(base_url=docker_server_url, verbose=True) as client:
            await client.authenticate("test@example.com")
            print(f"Visiting IMDb watchlist page: {url}")
            
            # Configure browser and crawler settings
            browser_config = BrowserConfig(headless=True)
            crawler_config = CrawlerRunConfig(
                capture_network_requests=True,
                capture_console_messages=True,
                only_text=True,
                page_timeout=30000,  # 30 seconds timeout
                cache_mode=CacheMode.BYPASS
            )
            
            # Run the crawl
            results = await client.crawl(
                [url],
                browser_config=browser_config,
                crawler_config=crawler_config
            )
            
            if not results:
                raise Exception("Crawl failed - no results returned")
            
            # Handle the results structure - it might be a tuple or list
            if isinstance(results, (tuple, list)):
                if len(results) == 0:
                    raise Exception("Crawl returned empty results")
                # Get the first result
                result = results[0]
            else:
                # If it's a single result object
                result = results
            
            if not result.success:
                raise Exception(f"Failed to load IMDb page: {result.error_message}")
            
            if not result.network_requests:
                raise Exception("No network requests captured")
            
            print(f"Captured {len(result.network_requests)} network events")
            
            # Filter for GraphQL API requests
            graphql_requests = []
            for request in result.network_requests:
                if (request.get("event_type") == "request" and 
                    request.get("url") and 
                    "api.graphql.imdb.com" in request.get("url")):
                    graphql_requests.append(request)
            
            print(f"Found {len(graphql_requests)} GraphQL requests")
            
            # Log all found operations for debugging
            found_operations = []
            for request in graphql_requests:
                request_url = request.get("url", "")
                operation_match = re.search(r'operationName=([^&]+)', request_url)
                if operation_match:
                    operation_name = operation_match.group(1)
                    if operation_name not in found_operations:
                        found_operations.append(operation_name)
            
            print(f"Found operations: {', '.join(found_operations)}")
            
            # Priority order for hash extraction (preferred operations first)
            # TODO: Remove this dumb list
            priority_operations = [
                "WatchListPage",             # Initial page load - likely what we actually get
                "WatchListPageRefiner",      # Pagination/refinement - what we want to use
                "PersonalizedUserData",      # Most relevant from your examples (deals with ID arrays)
                "YourPredefinedListsSidebar", # Might be related to watchlists
                "YourListsSidebar",          # User lists
                "YourExports",               # Export functionality 
                "RVI_Items"                  # Recently viewed items
            ]
            
            # First, try to find hashes from priority operations
            for operation_name in priority_operations:
                for request in graphql_requests:
                    request_url = request.get("url", "")
                    if f"operationName={operation_name}" in request_url:
                        print(f"Found {operation_name} request: {request_url}")
                        
                        # Extract the extensions parameter which contains the hash
                        try:
                            # Parse URL parameters
                            if "extensions=" in request_url:
                                # Find the extensions parameter
                                extensions_match = re.search(r'extensions=([^&]+)', request_url)
                                if extensions_match:
                                    extensions_encoded = extensions_match.group(1)
                                    extensions_decoded = unquote(extensions_encoded)
                                    extensions_data = json.loads(extensions_decoded)
                                    
                                    # Extract the hash
                                    if ("persistedQuery" in extensions_data and 
                                        "sha256Hash" in extensions_data["persistedQuery"]):
                                        hash_value = extensions_data["persistedQuery"]["sha256Hash"]
                                        print(f"Successfully extracted hash from {operation_name}: {hash_value}")
                                        return hash_value
                        except (json.JSONDecodeError, KeyError) as e:
                            print(f"Error parsing extensions data from {operation_name}: {e}")
                            continue
            
            # If no priority operations found, extract from any GraphQL request
            print("No priority operations found, checking all GraphQL requests...")
            for request in graphql_requests:
                request_url = request.get("url", "")
                
                # Extract operation name for logging
                operation_match = re.search(r'operationName=([^&]+)', request_url)
                operation_name = operation_match.group(1) if operation_match else "unknown"
                
                try:
                    if "extensions=" in request_url:
                        extensions_match = re.search(r'extensions=([^&]+)', request_url)
                        if extensions_match:
                            extensions_encoded = extensions_match.group(1)
                            extensions_decoded = unquote(extensions_encoded)
                            extensions_data = json.loads(extensions_decoded)
                            
                            if ("persistedQuery" in extensions_data and 
                                "sha256Hash" in extensions_data["persistedQuery"]):
                                hash_value = extensions_data["persistedQuery"]["sha256Hash"]
                                print(f"Found hash in {operation_name} operation: {hash_value}")
                                return hash_value
                except (json.JSONDecodeError, KeyError):
                    continue
            
            raise Exception("Could not extract GraphQL hash from any network requests")
            
    except Exception as e:
        print(f"Error during hash extraction: {str(e)}")
        raise


async def main():
    """Main function to extract and output the hash."""
    try:
        hash_value = await extract_imdb_graphql_hash()
        
        # Output the result as JSON for easy parsing by Node.js
        result = {
            "success": True,
            "hash": hash_value,
            "timestamp": asyncio.get_event_loop().time()
        }
        
        print(json.dumps(result))
        
    except Exception as e:
        # Output error as JSON
        error_result = {
            "success": False,
            "error": str(e),
            "timestamp": asyncio.get_event_loop().time()
        }
        
        print(json.dumps(error_result))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main()) 