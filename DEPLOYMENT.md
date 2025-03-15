# Deployment Instructions

This document provides instructions for deploying the IMDB Watchlist Stremio addon to Vercel or Render.

## Deploying to Vercel (Recommended)

### Prerequisites
- A GitHub account
- A Vercel account (can sign up with GitHub)

### Steps

1. **Fork or push the repository to GitHub**
   - Fork this repository to your GitHub account, or push your local code to a new GitHub repository

2. **Connect to Vercel**
   - Go to [Vercel](https://vercel.com) and sign in with GitHub
   - Click "Add New..." > "Project"
   - Select your repository from the list
   - Vercel should automatically detect the project settings

3. **Configure deployment settings**
   - Framework preset: Select "Node.js"
   - Root directory: Leave as is (usually "/")
   - Build command: Leave empty (uses the default build steps)
   - Output directory: Leave empty (uses the default)
   - Click "Deploy"

4. **Access your addon**
   - Once deployed, Vercel will provide you with a URL (e.g., `https://your-project-name.vercel.app`)
   - Users can access your addon's configuration page at `https://your-project-name.vercel.app`
   - The Stremio addon URL will be `https://your-project-name.vercel.app/manifest.json`

## Deploying to Render

### Prerequisites
- A GitHub account
- A Render account (can sign up with GitHub)

### Steps

1. **Fork or push the repository to GitHub**
   - Fork this repository to your GitHub account, or push your local code to a new GitHub repository

2. **Connect to Render**
   - Go to [Render](https://render.com) and sign in
   - Click "New+" > "Web Service"
   - Connect your GitHub account and select your repository

3. **Configure the web service**
   - Name: Choose a name for your service
   - Environment: Select "Node"
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Select the free plan (or paid if you prefer)
   - Click "Create Web Service"

4. **Access your addon**
   - Once deployed, Render will provide you with a URL (e.g., `https://your-project-name.onrender.com`)
   - Users can access your addon's configuration page at `https://your-project-name.onrender.com`
   - The Stremio addon URL will be `https://your-project-name.onrender.com/manifest.json`

## Ensuring it works with Stremio

To verify the addon works with Stremio:

1. In Stremio, go to the Addons section
2. Click "Add Addon URL" and enter your deployed addon URL (e.g., `https://your-project-name.vercel.app/manifest.json`)
3. You'll be prompted to configure the addon by entering your IMDb User ID
4. After configuration and installation, you should see your IMDb watchlist in your Stremio catalog

## Troubleshooting

If you encounter any issues:

1. Check the logs in your Vercel or Render dashboard
2. Verify that the IMDb user ID is correct and the watchlist is public
3. Make sure all dependencies are installed correctly
4. Test the addon locally before deploying to identify any issues 