const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Fetches the IMDb watchlist for the given user ID
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<Array>} - The raw watchlist data
 */
async function getImdbWatchlist(userId) {
    // URL and headers for the request
    const url = `https://www.imdb.com/user/${userId}/watchlist/`;
    
    // Simplified headers
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Referer": `https://www.imdb.com/user/${userId}/watchlist/?ref_=login`
    };
    
    try {
        // Making the request
        const response = await axios.get(url, { headers });
        
        if (response.status !== 200) {
            console.error(`Failed to retrieve data: Status code ${response.status}`);
            return null;
        }
        
        // Find the script tag containing the watchlist data
        const html = response.data;
        const scriptTagMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
        
        if (!scriptTagMatch || !scriptTagMatch[1]) {
            console.error("Could not find watchlist data in the response");
            console.error("This could be due to the user having a private watchlist or an invalid user ID");
            return null;
        }
        
        // Extract the JSON data
        try {
            const jsonData = JSON.parse(scriptTagMatch[1]);
            
            // Navigate to the watchlist items
            const watchlist = jsonData?.props?.pageProps?.mainColumnData?.predefinedList?.titleListItemSearch?.edges || [];
            
            if (!watchlist || watchlist.length === 0) {
                console.error("No items found in watchlist or unexpected JSON structure");
                console.error("This could be due to an empty watchlist or a change in IMDb's website structure");
            }
            
            return watchlist;
        } catch (e) {
            console.error(`Error processing response data: ${e.message}`);
            return null;
        }
    } catch (error) {
        console.error(`Error fetching watchlist: ${error.message}`);
        throw error;
    }
}

/**
 * Processes the watchlist data into a structured format
 * @param {Array} watchlist - The raw watchlist data
 * @returns {Array} - Processed movie/show data
 */
function processWatchlist(watchlist) {
    if (!watchlist || watchlist.length === 0) {
        console.error("No watchlist data to process");
        return [];
    }
    
    const movies = [];
    
    for (const item of watchlist) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        
        // Extract movie data
        const movieData = item.listItem;
        
        if (!movieData) {
            continue;
        }
        
        // Extract relevant information
        const movie = {
            id: movieData.id,
            title: movieData.titleText?.text || null,
            type: movieData.titleType?.text || null,
            year: movieData.releaseYear?.year || null,
            rating: movieData.ratingsSummary?.aggregateRating || null,
            genres: [],
            plot: movieData.plot?.plotText?.plainText || null,
            image_url: movieData.primaryImage?.url || null,
            runtime_seconds: movieData.runtime?.seconds || null,
            directors: [],
            cast: []
        };
        
        // Extract genres
        if (movieData.titleGenres && movieData.titleGenres.genres) {
            const genres = movieData.titleGenres.genres;
            for (const genre of genres) {
                if (genre && typeof genre === 'object' && 'genre' in genre) {
                    const genreText = genre.genre?.text;
                    if (genreText) {
                        movie.genres.push(genreText);
                    }
                }
            }
        }
        
        // Extract directors and cast - improved to better match IMDb structure
        if (movieData.principalCredits && Array.isArray(movieData.principalCredits)) {
            // Process each credit category (director, cast, etc.)
            for (const creditGroup of movieData.principalCredits) {
                // Make sure we have a valid credit group with category ID
                if (!creditGroup || !creditGroup.category || !creditGroup.category.id) {
                    continue;
                }
                
                const categoryId = creditGroup.category.id;
                const credits = creditGroup.credits || [];
                
                // Process directors
                if (categoryId === 'director') {
                    for (const director of credits) {
                        if (director && director.name && director.name.nameText && director.name.nameText.text) {
                            movie.directors.push(director.name.nameText.text);
                        }
                    }
                }
                // Process cast
                else if (categoryId === 'cast') {
                    for (const actor of credits) {
                        if (actor && actor.name && actor.name.nameText && actor.name.nameText.text) {
                            movie.cast.push(actor.name.nameText.text);
                        }
                    }
                }
            }
        }
        
        // Log extraction for debugging
        if (typeof console.verbose === 'function') {
            console.verbose(`Extracted data for ${movie.title}:`);
            console.verbose(`- Directors: ${movie.directors.join(', ') || 'None'}`);
            console.verbose(`- Cast: ${movie.cast.slice(0, 3).join(', ')}${movie.cast.length > 3 ? '...' : '' || 'None'}`);
        }
        
        movies.push(movie);
    }
    
    return movies;
}

/**
 * Formats runtime in seconds to a human-readable format
 * @param {number} seconds - Runtime in seconds
 * @returns {string} - Formatted runtime string
 */
function formatRuntime(seconds) {
    if (!seconds) {
        return "N/A";
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

/**
 * Converts the watchlist to Stremio format
 * @param {Array} movies - Processed movie data
 * @returns {Object} - Stremio-formatted watchlist
 */
function convertToStremioFormat(movies) {
    const stremioItems = [];
    
    for (const movie of movies) {
        if (!movie.id) continue;
        
        // Base meta object with required fields
        const metaObj = {
            "id": movie.id,
            "name": movie.title,
            "poster": movie.image_url,
            "posterShape": "poster",
            "type": (movie.type === 'Movie') ? "movie" : "series",
            "genres": movie.genres || [],
            "description": movie.plot || "",
        };
        
        // Add optional fields if available
        if (movie.rating) {
            metaObj.imdbRating = movie.rating.toString();
        }
        
        if (movie.year) {
            metaObj.releaseInfo = movie.year.toString();
        }
        
        if (movie.directors && movie.directors.length > 0) {
            metaObj.director = movie.directors;
        }
        
        if (movie.cast && movie.cast.length > 0) {
            metaObj.cast = movie.cast;
        }
        
        // Add runtime if available
        if (movie.runtime_seconds) {
            metaObj.runtime = formatRuntime(movie.runtime_seconds);
        }
        
        // Add only if it's a valid movie or series type
        if (movie.type === 'Movie' || ['TV Series', 'TV Mini Series'].includes(movie.type)) {
            stremioItems.push(metaObj);
        }
    }
    
    return {
        "metas": stremioItems
    };
}

/**
 * Prints a summary of the watchlist
 * @param {Array} movies - Processed movie data
 */
function printWatchlistSummary(movies) {
    if (!movies || movies.length === 0) {
        console.log("No movies found in watchlist");
        return;
    }
    
    console.log(`\n===== WATCHLIST SUMMARY =====`);
    console.log(`Total items: ${movies.length}`);
    
    // Only log the first 10 items to avoid extremely long logs
    const itemsToShow = Math.min(10, movies.length);
    console.log(`\nShowing first ${itemsToShow} items:`);
    
    for (let i = 0; i < itemsToShow; i++) {
        const movie = movies[i];
        const runtime = formatRuntime(movie.runtime_seconds);
        const genresText = movie.genres.length > 0 ? ` | Genres: ${movie.genres.join(", ")}` : '';
        
        console.log(`${i+1}. ${movie.title} (${movie.year}) - ${movie.type} | Rating: ${movie.rating || 'N/A'}/10${genresText}`);
    }
    
    if (movies.length > itemsToShow) {
        console.log(`... and ${movies.length - itemsToShow} more items`);
    }
    
    console.log(`\n===== END OF SUMMARY =====`);
}

/**
 * Main function to fetch and process an IMDb watchlist
 * @param {string} imdbUserId - The IMDb user ID
 * @returns {Promise<Object>} - Stremio-formatted watchlist
 */
async function fetchWatchlist(imdbUserId) {
    console.log(`Fetching IMDb watchlist for user ${imdbUserId}...`);
    
    try {
        // Fetch and process the watchlist
        const watchlist = await getImdbWatchlist(imdbUserId);
        
        if (watchlist) {
            console.log(`Raw watchlist data received from IMDb for user ${imdbUserId} (${watchlist.length} items)`);
            const movies = processWatchlist(watchlist);
            
            if (movies && movies.length > 0) {
                console.log(`Successfully processed ${movies.length} movies/shows from IMDb`);
                
                // Log more details about what was fetched - only if console.verbose exists
                if (typeof console.verbose === 'function') {
                    const movieCount = movies.filter(m => m.type === 'Movie').length;
                    const seriesCount = movies.filter(m => m.type === 'TV Series' || m.type === 'TV Mini Series').length;
                    const otherCount = movies.length - movieCount - seriesCount;
                    
                    console.verbose(`Watchlist breakdown:`);
                    console.verbose(`- Movies: ${movieCount}`);
                    console.verbose(`- TV Series: ${seriesCount}`);
                    if (otherCount > 0) {
                        console.verbose(`- Other types: ${otherCount}`);
                    }
                }
                
                // Convert to Stremio format
                const stremioWatchlist = convertToStremioFormat(movies);
                console.log(`Converted ${stremioWatchlist.metas.length} items to Stremio format`);
                
                // Print summary to console (only if verbose)
                if (typeof console.verbose === 'function') {
                    printWatchlistSummary(movies);
                }
                
                return stremioWatchlist;
            } else {
                console.error("No movies were processed from the watchlist");
                throw new Error("No movies were processed from the watchlist");
            }
        } else {
            console.error("Failed to retrieve watchlist data.");
            throw new Error("Failed to retrieve watchlist data");
        }
    } catch (error) {
        console.error(`An error occurred: ${error.message}`);
        throw error;
    }
}

module.exports = {
    fetchWatchlist
}; 