const axios = require('axios');
const constants = require('../constants');
const { JSDOM } = require('jsdom');

/**
 * Fetches the IMDb watchlist for the given user ID by extracting data from HTML
 * @param {string} userId - The IMDb user ID
 * @returns {Promise<Array>} - The raw watchlist data in the same format as before
 */
async function getImdbWatchlist(userId) {
    const url = `https://www.imdb.com/user/${userId}/watchlist/`;
    
    const headers = {
        'User-Agent': constants.IMDB_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none'
    };
    
    try {
        const response = await axios.get(url, { headers });
        
        if (response.status !== 200) {
            console.error(`Failed to retrieve HTML: Status code ${response.status}`);
            throw new Error("Could not find an IMDb watchlist for this ID. Please check and try again.");
        }
        
        // Parse HTML with JSDOM
        const dom = new JSDOM(response.data);
        const document = dom.window.document;
        
        // Check page title for private list indicator
        const pageTitle = document.title;
        if (pageTitle && pageTitle.toLowerCase().includes('private list')) {
            throw new Error("This IMDb watchlist is private. Please make your watchlist public in your IMDb settings.");
        }
        
        // Find the __NEXT_DATA__ script tag
        const nextDataScript = document.querySelector('script[id="__NEXT_DATA__"]');
        
        if (!nextDataScript) {
            console.error('__NEXT_DATA__ script tag not found in HTML');
            throw new Error("Could not find an IMDb watchlist for this ID. Please check and try again.");
        }
        
        // Parse the JSON data
        const nextData = JSON.parse(nextDataScript.textContent);
        
        // Extract watchlist data
        const pageProps = nextData.props?.pageProps;
        if (!pageProps) {
            throw new Error("Could not find an IMDb watchlist for this ID. Please check and try again.");
        }
        
        const aboveTheFoldData = pageProps.aboveTheFoldData;
        const mainColumnData = pageProps.mainColumnData;
        
        if (!mainColumnData?.predefinedList) {
            throw new Error("Could not find an IMDb watchlist for this ID. Please check and try again.");
        }
        
        const predefinedList = mainColumnData.predefinedList;
        const titleListItemSearch = predefinedList.titleListItemSearch;
        
        // Check if titleListItemSearch is missing (another indicator of private lists)
        if (!titleListItemSearch) {
            throw new Error("This IMDb watchlist is private. Please make your watchlist public in your IMDb settings.");
        }
        
        // Return the edges array in the same format as the GraphQL response
        const edges = titleListItemSearch.edges || [];
        
        if (edges.length === 0) {
            console.error("No items found in watchlist");
            return null;
        }
        
        return edges;
        
    } catch (error) {
        console.error(`Error fetching watchlist: ${error.message}`);
        
        // If this is our specific private list error, propagate it
        if (error.message && error.message.includes("private")) {
            throw error;
        }
        
        // For network errors or other issues, throw a more user-friendly message
        throw new Error("Could not find an IMDb watchlist for this ID. Please check and try again.");
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
 * @param {Object} sortOptions - Sorting options (optional)
 * @returns {Object} - Stremio-formatted watchlist
 */
function convertToStremioFormat(movies, sortOptions = { by: 'added_at', order: 'asc' }) {
    // Clone the array to avoid modifying the original
    const sortedMovies = [...movies];
    
    // Sort the movies based on the provided options
    sortMovies(sortedMovies, sortOptions);
    
    const stremioItems = [];
    
    for (const movie of sortedMovies) {
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
 * Sorts movies array based on provided options
 * @param {Array} movies - Array of movies to sort (will be sorted in-place)
 * @param {Object} options - Sorting options
 * @param {string} options.by - Field to sort by ('title', 'year', 'rating', 'added_at')
 * @param {string} options.order - Sort order ('asc' or 'desc')
 */
function sortMovies(movies, options = {}) {
    const { by = 'added_at', order = 'asc' } = options;
    const multiplier = order.toLowerCase() === 'desc' ? -1 : 1;
    
    // For 'added_at' sort, we respect the original order from IMDb API
    // (which is the order items were added to the watchlist)
    if (by.toLowerCase() === 'added_at') {
        // For 'desc' order, we reverse the array
        if (order.toLowerCase() === 'desc') {
            movies.reverse();
        }
        // For 'asc' order, we keep the original order
        return;
    }
    
    movies.sort((a, b) => {
        let valueA, valueB;
        
        switch (by.toLowerCase()) {
            case 'year':
                valueA = a.year || 0;
                valueB = b.year || 0;
                return (valueA - valueB) * multiplier;
                
            case 'rating':
                valueA = a.rating || 0;
                valueB = b.rating || 0;
                return (valueA - valueB) * multiplier;
                
            case 'title':
            default:
                valueA = a.title || '';
                valueB = b.title || '';
                return valueA.localeCompare(valueB) * multiplier;
        }
    });
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
 * @param {Object} sortOptions - Sorting options (optional)
 * @returns {Promise<Object>} - Stremio-formatted watchlist
 */
async function fetchWatchlist(imdbUserId, sortOptions = { by: 'added_at', order: 'asc' }) {
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
                
                // Convert to Stremio format with sorting applied
                const stremioWatchlist = convertToStremioFormat(movies, sortOptions);
                console.log(`Converted ${stremioWatchlist.metas.length} items to Stremio format (sorted by ${sortOptions.by}, ${sortOptions.order})`);
                
                // Print summary to console (only if verbose)
                if (typeof console.verbose === 'function') {
                    printWatchlistSummary(movies);
                }
                
                return stremioWatchlist;
            } else {
                console.error("No movies were processed from the watchlist");
                throw new Error("This watchlist appears to be empty or may not contain any compatible movies or series.");
            }
        } else {
            console.error("Failed to retrieve watchlist data.");
            throw new Error("Could not find an IMDb watchlist for this ID. Please check and try again.");
        }
    } catch (error) {
        console.error(`An error occurred: ${error.message}`);
        // Pass through any specific errors (like private list error)
        throw error;
    }
}

module.exports = {
    fetchWatchlist,
    sortMovies,
    getImdbWatchlist
}; 