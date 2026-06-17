# Arcinity

A cross-platform video feed application that mimics TikTok's interface. Displays videos from categorized folders with smart recommendations, watch-time tracking, and adaptive content suggestions.

## 🎯 Features

- **TikTok-like Interface**: Vertical scroll video feed with smooth playback
- **Smart Recommendations**: AI-powered video suggestions based on watch history
- **Cross-Platform**: Works on Windows, macOS, and Linux without path modifications
- **Video Categorization**: Automatic clustering and organization of videos
- **Watch Tracking**: Records user interactions (watch time, likes) for personalization
- **Persistent State**: Remembers recent videos and user behavior across sessions
- **Audio Control**: Global and per-video audio management with user gesture handling

## 📋 System Requirements

- **Node.js**: v14+ (for server and build tools)
- **Python**: v3.7+ (for video categorization script)
- **ffmpeg**: (optional, for thumbnail generation)
- **OpenCV (cv2)**: (optional, for visual feature extraction)

### 🛠️ Deep Learning Indexing

Arcinity includes an advanced deep learning processor that automatically indexes your entire video library with speech transcription, visual embeddings, and audio feature extraction.

### What It Indexes

- **Speech Transcription**: Extracts and transcribes all audio (Whisper)
- **Visual Features**: Generates 512-dim CLIP embeddings for visual similarity
- **Audio Features**: Analyzes spectral, tempo, energy, and MFCC coefficients
- **Smart Skipping**: Auto-skips transcription for videos <5 seconds

### Performance Estimates

- **GPU (RTX 5070)**: 6-8 hours for 14,000 videos (Balanced preset, all optimizations)
- **GPU (RTX 3050)**: 15-20 hours for 14,000 videos
- **CPU (8-core)**: 40-60 hours for 14,000 videos
- **Laptop**: 3-5 days with automatic fallbacks

**👉 See [PERFORMANCE_GUIDE.md](PERFORMANCE_GUIDE.md) for detailed hardware recommendations!**

## Python Dependencies (Deep Learning)

## 🚀 Quick Start

### 1. Install Node Dependencies

```bash
npm install
```

### 2. Launch the Desktop Control Panel (Recommended)

```bash
npm run launcher
```

From the launcher GUI you can:
- Pick the `VIDEO_SOURCE_DIR` folder with a file picker
- Set the port number
- Start and stop the server
- Open the running app in your browser
- Monitor live server logs

### 3. Configure Your Video Paths (Optional Manual Mode)

Edit `config.js` and set your video directories:

```javascript
// Option A: Direct configuration in config.js
const VIDEO_SOURCE_DIR = "C:\\Users\\YourName\\Videos\\categorized_videos";
const MIXED_VIDEOS_DIR = "C:\\Users\\YourName\\Videos\\new_videos";
```

**OR**

```bash
# Option B: Use environment variables
export VIDEO_SOURCE_DIR="/path/to/categorized/videos"
export MIXED_VIDEOS_DIR="/path/to/new/videos"
```

### 4. Install Python Dependencies (Optional)

For video categorization features:

```bash
pip install numpy scikit-learn
pip install opencv-python  # Optional, for better visual analysis
```

### 5. Start the Server (CLI Mode)

```bash
npm start
```

The application will be available at `http://localhost:3000`

## 🪟 Build Windows EXE

Create an installable Windows executable:

```bash
npm run build:exe
```

Output files are generated in `dist/`, including:
- `dist/Arcinity Setup 1.0.0.exe`
- `dist/win-unpacked/Arcinity.exe`

## 🍎 Build macOS DMG

Run on a macOS machine:

```bash
npm run build:dmg
```

## 🐧 Build Linux Flatpak

Run on a Linux machine with Flatpak tooling installed.

Install build tools (example for Debian/Ubuntu):

```bash
sudo apt update
sudo apt install flatpak flatpak-builder
flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
```

Build Flatpak image and local repo:

```bash
npm run build:flatpak
```

Create a distributable Flatpak bundle:

```bash
npm run bundle:flatpak
```

Output bundle:
- `dist/Arcinity.flatpak`

## 📁 Directory Structure

```
.
├── config.js                      # Cross-platform configuration
├── server.js                      # Express server and API
├── app.js                         # Frontend JavaScript (TikTok-like UI)
├── recommender.js                 # Recommendation engine
├── catagorize.py                  # Video clustering and organization
├── index.html                     # Frontend HTML
├── styles.css                     # UI styling
├── package.json                   # Node dependencies
├── electron/
│   ├── main.js                    # Electron main process (launcher backend)
│   ├── preload.js                 # Secure bridge for renderer IPC
│   ├── renderer.html              # Launcher UI
│   ├── renderer.css               # Launcher styling
│   └── renderer.js                # Launcher UI logic
├── data/
│   ├── behavior.json              # User watch history (auto-created)
│   └── recent.json                # Recent videos (auto-created)
├── scripts/
│   ├── extract_audio_features.py  # Audio analysis
│   └── extract_visual_features.py # Visual analysis
├── flatpak/
│   ├── com.arcinity.launcher.yml  # Flatpak manifest
│   ├── com.arcinity.launcher.desktop
│   ├── com.arcinity.launcher.metainfo.xml
│   ├── com.arcinity.launcher.svg
│   └── run-arcinity.sh            # Flatpak entrypoint wrapper
└── thumbs/                        # Cached video thumbnails
    └── [category folders]/
```

## ⚙️ Configuration Guide

### config.js Setup

The `config.js` file is the central point for all path configuration. It automatically:

- Validates that paths are set
- Supports environment variables for CI/CD environments
- Provides sensible defaults (user's Videos folder)
- Works across Windows, macOS, and Linux

**Platform-Specific Examples:**

**Windows:**
```javascript
const VIDEO_SOURCE_DIR = "C:\\Users\\YourName\\Videos\\organized_videos";
const MIXED_VIDEOS_DIR = "C:\\Users\\YourName\\Videos\\new_videos";
```

**macOS/Linux:**
```javascript
const VIDEO_SOURCE_DIR = "/Users/YourName/Videos/organized_videos";
const MIXED_VIDEOS_DIR = "/home/YourName/Videos/new_videos";
```

### Environment Variables

For deployment or automation, set environment variables instead:

```bash
# Windows PowerShell
$env:VIDEO_SOURCE_DIR = "C:\Users\YourName\Videos\videos"
$env:MIXED_VIDEOS_DIR = "C:\Users\YourName\Videos\new"
npm start

# macOS/Linux
export VIDEO_SOURCE_DIR=/Users/YourName/Videos/videos
export MIXED_VIDEOS_DIR=/Users/YourName/Videos/new
npm start
```

## 🎬 Video Organization

### Method 1: Manual Organization

Organize videos into category folders:

```
categorized_videos/
├── Luxury/
│   ├── video1.mp4
│   ├── video2.mp4
│   └── video3.mp4
├── Nature/
│   ├── clip1.mp4
│   └── clip2.webm
└── Travel/
    └── adventure.mov
```

Then set `VIDEO_SOURCE_DIR` to this directory.

### Method 2: Automatic Categorization

Use the `catagorize.py` script to automatically cluster and organize videos:

```bash
# Install dependencies
pip install numpy scikit-learn

# Run categorization
python catagorize.py
```

**Configuration for catagorize.py:**

Edit `catagorize.py` or use environment variables:

```bash
export MIXED_VIDEOS_DIR="/path/to/uncategorized/videos"
export VIDEO_SOURCE_DIR="/path/to/output/categories"
python catagorize.py
```

## 🔌 API Reference

### GET /api/posts

Fetch paginated video posts.

**Query Parameters:**
- `offset` (default: 0): Starting position for posts
- `limit` (default: 50, max: 200): Number of posts to return

**Response:**
```json
{
  "total": 1000,
  "posts": [
    {
      "videoUrl": "/videos/Luxury/video1.mp4",
      "thumbnailUrl": "/videos/Luxury/video1.webp",
      "user": "Luxury",
      "caption": "video1.mp4",
      "song": ""
    }
  ]
}
```

### POST /api/track

Record user interactions (watch time, likes).

**Request Body:**
```json
{
  "key": "Category/filename.mp4",
  "watchTime": 5.5,
  "action": "like" | "skip"
}
```

**Response:**
```json
{ "ok": true }
```

## 📊 Understanding the Recommendation System

The recommendation engine analyzes:

1. **Watch History**: How long users watch each video
2. **User Preferences**: Like/skip patterns
3. **Content Features**: 
   - Text-based similarity (filename analysis)
   - Visual features (colors, objects)
   - Audio characteristics (optional)

Videos are clustered and ranked based on:
- Similarity to liked videos
- User engagement patterns
- Recency and diversity

## 🛠️ Development

### Running with Auto-Reload

```bash
npm run dev
```

Uses `nodemon` to automatically restart the server when files change.

### Debugging

Enable debug logging:

```bash
# Windows PowerShell
$env:DEBUG = "Arcinity:*"
npm start

# macOS/Linux
DEBUG=Arcinity:* npm start
```

### Performance Optimization

- **Thumbnail Caching**: Pre-generated WebP thumbnails (faster loading)
- **Lazy Video Loading**: Videos only load when visible (IntersectionObserver)
- **Batched Tracking**: User interactions batched and sent periodically
- **In-Memory Caching**: File lists cached with 30-second refresh

## 📝 File Format Support

- **Video**: `.mp4`, `.mov`, `.webm`, `.mkv`, `.avi`
- **Thumbnails**: Auto-generated as `.webp` by ffmpeg

## 🔒 Data Privacy

- **User Data**: Stored locally in `data/` folder (JSON files)
- **Behavior Tracking**: Never sent externally, only stored locally
- **Recent Queue**: Limited to 50 entries to prevent unbounded growth

## 🐛 Troubleshooting

### "No videos found" Error

1. Check that `VIDEO_SOURCE_DIR` is set correctly in `config.js`
2. Verify the folder path exists and contains video files
3. Ensure videos are in subdirectories (categories)

```javascript
// ✅ Correct structure
categorized_videos/
  └── Category1/
      └── video.mp4

// ❌ Incorrect (videos in root)
categorized_videos/
  └── video.mp4
```

### Server Won't Start

```bash
# Check Node version
node --version  # Should be v14+

# Reinstall dependencies
rm -r node_modules package-lock.json
npm install

# Check port availability
# If port 3000 is in use, set a different port:
PORT=3001 npm start
```

### Videos Won't Play

1. Verify video format is supported (see File Format Support)
2. Check browser console for CORS errors
3. Ensure videos are readable (check file permissions)
4. Try a different browser

### Python Script Errors

```bash
# Install missing dependencies
pip install numpy scikit-learn opencv-python

# Check Python version
python --version  # Should be 3.7+

# Verify paths exist
python -c "import os; print(os.path.exists('/path/to/videos'))"
```

## 🎨 Customization

### Styling

Edit `styles.css` to customize:
- Colors and fonts
- Layout spacing
- Animation speeds
- UI element appearance

### Video Feed Behavior

Edit `app.js` to adjust:
- Number of videos loaded per page: `const PAGE = 30`
- Thumbnail generation settings
- Interaction handlers (like, share, comment buttons)

### Recommendation Settings

Edit `recommender.js` to tune:
- Recommendation count
- Feature weighting
- Similarity thresholds
- Clustering parameters

## 📄 License

This project is provided as-is for personal use.

## 🤝 Contributing

Feel free to extend this project:

- Add new video formats
- Implement additional recommendation algorithms
- Create mobile-responsive UI
- Add database persistence
- Integrate cloud storage (S3, Google Drive, etc.)

## 📚 Additional Resources

- [Express.js Documentation](https://expressjs.com/)
- [scikit-learn KMeans](https://scikit-learn.org/stable/modules/generated/sklearn.cluster.KMeans.html)
- [OpenCV Python](https://docs.opencv.org/master/d6/d00/tutorial_py_root.html)
- [Web APIs - IntersectionObserver](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API)

---

**Last Updated**: January 2026
**Tested On**: Windows, macOS, Linux
