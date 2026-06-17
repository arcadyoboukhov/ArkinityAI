/**
 * Configuration Module for Arcinity
 * =============================================
 * 
 * This module provides centralized, cross-platform path configuration for the application.
 * It handles path setup for both Node.js (server) and Python (categorization) scripts.
 * 
 * IMPORTANT: All hardcoded paths have been removed. This file and environment variables
 * are now the ONLY place to configure paths, ensuring the app works on any PC.
 * 
 * SETUP INSTRUCTIONS:
 * 
 * Option 1: Direct Configuration (Edit this file)
 * -----------------------------------------------
 * Change the VIDEO_SOURCE_DIR and MIXED_VIDEOS_DIR values below to match your system:
 * 
 *   Windows example:
 *     const VIDEO_SOURCE_DIR = "C:\\Users\\YourName\\Videos\\categorized_videos";
 *   
 *   macOS example:
 *     const VIDEO_SOURCE_DIR = "/Users/YourName/Videos/categorized_videos";
 *   
 *   Linux example:
 *     const VIDEO_SOURCE_DIR = "/home/YourName/Videos/categorized_videos";
 * 
 * Option 2: Environment Variables (No file editing needed)
 * ---------------------------------------------------------
 * Set these before running the server:
 * 
 *   Windows PowerShell:
 *     $env:VIDEO_SOURCE_DIR = "C:\Users\YourName\Videos\videos"
 *     npm start
 *   
 *   macOS/Linux bash:
 *     export VIDEO_SOURCE_DIR="/Users/YourName/Videos/videos"
 *     npm start
 * 
 * WHAT GOES WHERE:
 * 
 * VIDEO_SOURCE_DIR:
 *   - Directory containing organized video categories
 *   - Should have subdirectories for each category
 *   - Example structure:
 *       categorized_videos/
 *         â”œâ”€â”€ Luxury/
 *         â”‚   â”œâ”€â”€ video1.mp4
 *         â”‚   â””â”€â”€ video2.mp4
 *         â””â”€â”€ Nature/
 *             â”œâ”€â”€ clip1.mp4
 *             â””â”€â”€ clip2.webm
 *     - Each Catagory can instead be Usernames or Hashtags as needed
 *     - Example structure:
 *       categorized_videos/
 *         â”œâ”€â”€ ExampleUser/
 *         â”‚   â”œâ”€â”€ video1.mp4
 *         â”‚   â””â”€â”€ video2.mp4
 *         â””â”€â”€ ExampleUser2/
 *             â”œâ”€â”€ clip1.mp4
 *             â””â”€â”€ clip2.webm
 * MIXED_VIDEOS_DIR:
 *   - Directory containing uncategorized videos
 *   - Used by catagorize.py to organize and move videos
 *   - Script will categorize these and move to VIDEO_SOURCE_DIR
 * 
 * Usage in code:
 *   const config = require('./config');
 *   const { isValid, errors } = config.validate();
 *   if (!isValid) {
 *     console.error('Config errors:', errors);
 *     process.exit(1);
 *   }
 *   const videoRoot = config.videoRoot; // Use configured path
 */

const path = require('path');
const os = require('os');

/**
 * =============================================================================
 * CONFIGURATION - CUSTOMIZE THESE FOR YOUR SYSTEM
 * =============================================================================
 */

// Set this to your categorized videos directory
// If null, defaults to ~/Videos/categorized_videos
const VIDEO_SOURCE_DIR = null;

// Set this to the directory containing uncategorized videos
// If null, defaults to ~/Videos/mixed_videos
const MIXED_VIDEOS_DIR = null;

// =============================================================================
// VALIDATION AND DEFAULTS
// =============================================================================

function getDefaultVideosPath() {
  const videosDir = path.join(os.homedir(), 'Videos', 'categorized_videos');
  return videosDir;
}

function getDefaultMixedPath() {
  const videosDir = path.join(os.homedir(), 'Videos', 'mixed_videos');
  return videosDir;
}

// Use environment variables first so launchers/GUI can override local defaults.
const videoRoot = process.env.VIDEO_SOURCE_DIR || VIDEO_SOURCE_DIR || getDefaultVideosPath();
const mixedVideosRoot = process.env.MIXED_VIDEOS_DIR || MIXED_VIDEOS_DIR || getDefaultMixedPath();

// Data directory for storing user behavior and recent videos.
// In packaged builds, this should be provided via ARCINITY_DATA_DIR and point to a writable user folder.
const dataDir = process.env.ARCINITY_DATA_DIR || path.join(__dirname, 'data');

/**
 * Validate configuration
 * @returns {Object} - { isValid: boolean, errors: string[] }
 */
function validate() {
  const errors = [];
  
  if (!videoRoot || videoRoot === getDefaultVideosPath()) {
    errors.push(
      'VIDEO_SOURCE_DIR not configured. Please set it in config.js or via environment variable.\n' +
      `  Default path checked: ${getDefaultVideosPath()}\n` +
      '  To configure:\n' +
      '    1. Edit config.js and set VIDEO_SOURCE_DIR directly, OR\n' +
      '    2. Set environment variable: VIDEO_SOURCE_DIR=/path/to/videos'
    );
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

module.exports = {
  // Directories
  videoRoot,
  mixedVideosRoot,
  dataDir,
  
  // Validation
  validate,
  
  // Helper to get path to recent.json
  getRecentPath: () => path.join(dataDir, 'recent.json'),
  
  // Helper to get path to behavior.json
  getBehaviorPath: () => path.join(dataDir, 'behavior.json'),

  // Helper to get path to thumbnail failure registry
  getThumbFailuresPath: () => process.env.ARCINITY_THUMB_FAILURES_PATH || path.join(dataDir, 'thumbnail-failures.json'),
  
  // Helper to display configuration
  display: () => ({
    videoRoot,
    mixedVideosRoot,
    dataDir
  })
};

