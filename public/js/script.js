document.addEventListener('DOMContentLoaded', function() {
    const imdbIdInput = document.getElementById('imdb-id');
    const installationOptions = document.getElementById('installation-options');
    const form = document.getElementById('config-form');

    // Check if we're in the configure path from Stremio
    const isConfiguration = window.location.pathname === '/configure' || window.location.pathname.includes('/configure');
    if (isConfiguration) {
        const configTitle = document.createElement('div');
        configTitle.classList.add('config-title');
        configTitle.textContent = 'Configure IMDb Watchlist Addon';
        form.prepend(configTitle);
    }

    // Check for userId in query parameters (for pre-populating from /:userId/configure)
    const urlParams = new URLSearchParams(window.location.search);
    const userIdParam = urlParams.get('userId');
    if (userIdParam) {
        imdbIdInput.value = userIdParam;
        // Validate and show installation options if the provided userId is valid
        if (userIdParam.startsWith('ur') && userIdParam.length > 3) {
            validateAndShowOptions(userIdParam);
        }
    }

    // Add debounce function for input validation
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    // Validate and show options when IMDb ID changes
    const debouncedValidate = debounce(function(value) {
        const imdbId = value.trim();
        
        // Hide installation options and clear previous options if ID is invalid
        if (!(imdbId && imdbId.startsWith('ur') && imdbId.length > 3)) {
            installationOptions.classList.add('hidden');
            installationOptions.innerHTML = '';
            
            // Remove any existing status messages
            const statusMessages = document.querySelectorAll('.status-message');
            statusMessages.forEach(el => el.remove());
            return;
        }
        
        validateAndShowOptions(imdbId);
    }, 500); // 500ms debounce

    // Listen for input changes
    imdbIdInput.addEventListener('input', function() {
        // Prevent accidentally clearing options during copying
        // Only call validate if the value actually changed
        const currentValue = this.value.trim();
        
        // Store the current value as a data attribute to track changes
        const previousValue = this.dataset.previousValue || '';
        this.dataset.previousValue = currentValue;
        
        // Only validate if the value actually changed
        if (currentValue !== previousValue) {
            debouncedValidate(currentValue);
        }
    });

    // Function to validate IMDb ID and show installation options
    function validateAndShowOptions(imdbId) {
        // Show loading message
        showStatusMessage('info', 'Validating IMDb ID...');
        
        // Validate ID exists on IMDb
        fetch(`/api/validate/${imdbId}`)
            .then(response => response.json())
            .then(data => {
                // Remove info message
                const infoMessages = document.querySelectorAll('.status-message.info');
                infoMessages.forEach(el => el.remove());
                
                if (data.valid) {
                    // Get the current host
                    const host = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
                        ? `${window.location.hostname}:${window.location.port}`
                        : window.location.host;
                    
                    // Create all the different URLs
                    const httpUrl = `http://${host}/${imdbId}/manifest.json`;
                    
                    // For Stremio Web (app.strem.io)
                    const webUrl = `https://app.strem.io/#/?addonOpen=${encodeURIComponent(httpUrl)}`;
                    
                    // For Stremio desktop app
                    const stremioProtocolUrl = `stremio://${httpUrl.replace(/^https?:\/\//, '')}`;
                    
                    // Show success message
                    showStatusMessage('success', `IMDb watchlist found! Choose how to install below:`);
                    
                    // Create installation options
                    createInstallationOptions(imdbId, httpUrl, webUrl, stremioProtocolUrl);
                } else {
                    showError('Could not find an IMDb watchlist for this ID. Please check and try again.');
                    installationOptions.classList.add('hidden');
                    installationOptions.innerHTML = '';
                }
            })
            .catch(error => {
                console.error('Validation error:', error);
                showError('An error occurred. Please try again later.');
                installationOptions.classList.add('hidden');
                installationOptions.innerHTML = '';
            });
    }
    
    function createInstallationOptions(imdbId, httpUrl, webUrl, stremioProtocolUrl) {
        // Clear and show the installation options container
        installationOptions.innerHTML = '';
        installationOptions.classList.remove('hidden');
        
        // Create the installation options HTML
        installationOptions.innerHTML = `
            <div class="options-container">
                <div class="installation-buttons">
                    <a href="${webUrl}" target="_blank" class="install-btn web">Open in Stremio Web</a>
                    <a href="${stremioProtocolUrl}" class="install-btn desktop">Open in Stremio Desktop</a>
                </div>
                
                <div class="manual-installation">
                    <p>Or copy this URL and add it manually in Stremio:</p>
                    <div class="url-container">
                        <input type="text" readonly value="${httpUrl}" id="addon-url">
                        <button id="copy-url-btn">Copy</button>
                    </div>
                    <p class="url-note">This URL already contains your IMDb ID and will install directly without configuration.</p>
                    <p class="url-note"><strong>Note:</strong> If Stremio still shows a "Configure" button instead of "Install", try refreshing your browser and then adding the URL again.</p>
                </div>
            </div>
        `;
        
        // Add copy functionality
        const copyBtn = document.getElementById('copy-url-btn');
        const urlInput = document.getElementById('addon-url');
        
        copyBtn.addEventListener('click', function(e) {
            // Prevent any default behavior or form submission
            e.preventDefault();
            
            // Store the current IMDb ID input value to ensure it doesn't get lost
            const originalImdbValue = imdbIdInput.value;
            
            // Use the Clipboard API instead of select() which can trigger unwanted events
            navigator.clipboard.writeText(urlInput.value)
                .then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                    }, 2000);
                })
                .catch(err => {
                    console.error('Failed to copy: ', err);
                    // Fallback to the old method if clipboard API fails
                    try {
                        // Create a temporary text area element to avoid focusing the actual input
                        const textarea = document.createElement('textarea');
                        textarea.value = urlInput.value;
                        textarea.setAttribute('readonly', '');
                        textarea.style.position = 'absolute';
                        textarea.style.left = '-9999px';
                        document.body.appendChild(textarea);
                        
                        textarea.select();
                        document.execCommand('copy');
                        document.body.removeChild(textarea);
                        
                        // Ensure the original IMDb ID input value is preserved
                        imdbIdInput.value = originalImdbValue;
                        
                        copyBtn.textContent = 'Copied!';
                        setTimeout(() => {
                            copyBtn.textContent = 'Copy';
                        }, 2000);
                    } catch (e) {
                        console.error('Fallback copy failed: ', e);
                    }
                });
                
            // Make sure the IMDb ID input still has its original value
            setTimeout(() => {
                if (imdbIdInput.value !== originalImdbValue) {
                    imdbIdInput.value = originalImdbValue;
                }
            }, 100);
        });
    }
    
    // Show error message
    function showError(message) {
        showStatusMessage('error', message);
    }
    
    // Show status message (error, success, info)
    function showStatusMessage(type, message) {
        // Remove existing messages of the same type
        const existingMessages = document.querySelectorAll(`.status-message.${type}`);
        existingMessages.forEach(el => el.remove());
        
        // Create message element
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('status-message', type);
        messageDiv.textContent = message;
        
        // Add to form
        form.appendChild(messageDiv);
        // Make it the fourth child of the form
        form.insertBefore(messageDiv, form.children[1]);
        
        // Auto-remove error messages after 5 seconds
        if (type === 'error') {
            setTimeout(() => {
                if (messageDiv.parentNode) {
                    messageDiv.parentNode.removeChild(messageDiv);
                }
            }, 5000);
        }
    }
}); 