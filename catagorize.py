import os
import sys
import shutil
from collections import defaultdict
from pathlib import Path

try:
    import numpy as np
except Exception:
    print("Error: numpy is required. Please install numpy in the active Python environment.")
    raise

try:
    from sklearn.cluster import KMeans
    from sklearn.preprocessing import StandardScaler
    from sklearn.decomposition import PCA
except Exception:
    KMeans = None
    StandardScaler = None
    PCA = None

try:
    import cv2
except Exception:
    cv2 = None


# =============================================================================
# CONFIGURATION - CUSTOMIZE THESE PATHS FOR YOUR SYSTEM
# =============================================================================
# 
# Set these to match your video locations. You can also use environment
# variables: MIXED_VIDEOS_DIR and VIDEO_SOURCE_DIR
#
# Examples:
#   Windows: r"C:\Users\YourName\Videos\new_videos"
#   macOS:   "/Users/YourName/Videos/new_videos"
#   Linux:   "/home/YourName/Videos/new_videos"

# Directory containing uncategorized videos to process
mixed_clips_folder = os.environ.get(
    'MIXED_VIDEOS_DIR',
    str(Path.home() / 'Videos' / 'mixed_videos')
)

# Directory where categorized videos will be stored
categories_folder = os.environ.get(
    'VIDEO_SOURCE_DIR',
    str(Path.home() / 'Videos' / 'categorized_videos')
)

# Helper functions
def _text_vector_from_name(name, dim=64):
    name = os.path.basename(name).lower()
    toks = [t for t in ''.join(ch if ch.isalnum() else ' ' for ch in name).split() if t]
    vec = np.zeros(dim, dtype=float)
    for t in toks:
        h = sum(ord(c) for c in t) % dim
        vec[h] += 1.0
    n = np.linalg.norm(vec)
    if n > 0: vec /= n
    return vec

def extract_video_features(video_path, num_frames=8):
    # If cv2 is not available, fall back to simple file-based features
    if cv2 is None:
        size = os.path.getsize(video_path)
        size_vec = np.array([(size >> i) & 0xff for i in range(0, 64, 8)], dtype=float)
        size_vec = size_vec / (np.linalg.norm(size_vec) + 1e-9)
        text_vec = _text_vector_from_name(video_path, dim=64)
        return np.concatenate([size_vec, text_vec])

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if total_frames <= 0:
        cap.release()
        return None

    picks = [min(total_frames - 1, int(i * total_frames / max(1, num_frames))) for i in range(num_frames)]

    color_hist_acc = None
    try:
        orb = cv2.ORB_create(500)
    except Exception:
        orb = None
    orb_descs = []

    for fidx in picks:
        cap.set(cv2.CAP_PROP_POS_FRAMES, fidx)
        ret, frame = cap.read()
        if not ret or frame is None:
            continue
        try:
            small = cv2.resize(frame, (224, 224))
        except Exception:
            continue

        # Color Histogram
        try:
            hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
            h = cv2.calcHist([hsv], [0,1,2], None, [8,8,4], [0,180,0,256,0,256])
            h = h.flatten()
            if color_hist_acc is None:
                color_hist_acc = h
            else:
                color_hist_acc += h
        except Exception:
            pass

        # ORB Descriptors
        if orb is not None:
            try:
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                kps, desc = orb.detectAndCompute(gray, None)
                if desc is not None and desc.size:
                    orb_descs.append(np.mean(desc.astype(float), axis=0))
            except Exception:
                pass

    cap.release()

    # If we couldn't get visual descriptors, fall back to size+name
    if color_hist_acc is None:
        size = os.path.getsize(video_path)
        size_vec = np.array([(size >> i) & 0xff for i in range(0, 64, 8)], dtype=float)
        size_vec = size_vec / (np.linalg.norm(size_vec) + 1e-9)
        text_vec = _text_vector_from_name(video_path, dim=64)
        return np.concatenate([size_vec, text_vec])

    color_hist_acc = color_hist_acc.astype(float)
    color_hist_acc /= (np.linalg.norm(color_hist_acc) + 1e-9)

    orb_mean = np.zeros(32, dtype=float)
    if orb_descs:
        orb_mean = np.mean(np.stack(orb_descs, axis=0), axis=0)
        orb_mean /= (np.linalg.norm(orb_mean) + 1e-9)

    text_vec = _text_vector_from_name(video_path, dim=64)

    feat = np.concatenate([color_hist_acc[:256], orb_mean[:32], text_vec])
    feat = feat / (np.linalg.norm(feat) + 1e-9)
    return feat

def get_all_video_features():
    # Snapshot the directory so moves during processing don't affect iteration
    try:
        all_files = [f for f in os.listdir(mixed_clips_folder) if f.lower().endswith(('.mp4', '.mov', '.webm', '.avi'))]
    except FileNotFoundError:
        print(f"Mixed clips folder not found: {mixed_clips_folder}")
        return np.array([]), []

    video_features = []
    video_paths = []

    for video_file in list(all_files):
        video_path = os.path.normpath(os.path.join(mixed_clips_folder, video_file))
        print(f"Extracting features from {video_path}...")
        features = extract_video_features(video_path)
        if features is not None:
            video_features.append(features)
            video_paths.append(video_path)

    if not video_features:
        return np.array([]), []
    return np.array(video_features), video_paths

def cluster_videos(video_features):
    # If sklearn is not available, fall back to a single cluster
    if KMeans is None or StandardScaler is None or PCA is None:
        print("sklearn not available — grouping all videos into a single category.")
        return np.zeros(len(video_features), dtype=int)

    # Standardize the features
    scaler = StandardScaler()
    video_features_scaled = scaler.fit_transform(video_features)

    # Apply PCA for dimensionality reduction (to speed up clustering)
    n_components = min(50, max(1, video_features_scaled.shape[1] - 1))
    pca = PCA(n_components=n_components)
    reduced_features = pca.fit_transform(video_features_scaled)

    # Clustering videos using KMeans (the number of clusters can be adjusted dynamically)
    num_clusters = max(1, int(len(video_features) / 10))  # e.g., 1 cluster per 10 videos
    num_clusters = min(num_clusters, len(video_features))
    kmeans = KMeans(n_clusters=num_clusters, random_state=42)
    kmeans.fit(reduced_features)
    return kmeans.labels_

def move_videos_to_categories(video_paths, cluster_labels):
    category_folders = defaultdict(list)
    moved = 0
    failed = 0
    failures = []

    for video_path, label in zip(video_paths, cluster_labels):
        # Normalize paths
        src = os.path.normpath(video_path)
        category_folder = os.path.normpath(os.path.join(categories_folder, f"category_{label}"))
        os.makedirs(category_folder, exist_ok=True)

        filename = os.path.basename(src)
        target_path = os.path.normpath(os.path.join(category_folder, filename))

        if not os.path.exists(src):
            failed += 1
            failures.append((src, target_path, 'source-not-found'))
            print(f"Source not found, skipping: {src}")
            continue

        try:
            shutil.move(src, target_path)
            moved += 1
            category_folders[label].append(target_path)
            print(f"Moved: {src} -> {target_path}")
        except Exception as e:
            failed += 1
            failures.append((src, target_path, str(e)))
            print(f"Failed to move {src} -> {target_path}: {e}")

    # Report
    print("\n=== Categorization Report ===")
    print(f"  Total files processed: {len(video_paths)}")
    print(f"  Total moved: {moved}")
    print(f"  Total failed/skipped: {failed}")
    for label, videos in category_folders.items():
        print(f"  Category {label} contains {len(videos)} videos.")

    # Write CSV report of failures for debugging
    try:
        import csv
        with open('categorize_report.csv', 'w', newline='', encoding='utf-8') as fh:
            writer = csv.writer(fh)
            writer.writerow(['source','target','status'])
            for s,t,st in failures:
                writer.writerow([s,t,st])
            # Also list moved items
            for label, videos in category_folders.items():
                for v in videos:
                    writer.writerow([v, os.path.join(categories_folder, f'category_{label}'), 'moved'])
    except Exception:
        pass

def organize_mixed_folder():
    # Step 1: Extract features for all videos
    video_features, video_paths = get_all_video_features()

    if len(video_features) == 0:
        print("No videos found in the mixed folder.")
        return

    # Step 2: Perform clustering to dynamically create categories
    print("Clustering videos...")
    cluster_labels = cluster_videos(video_features)

    # Step 3: Move videos to respective categories
    print("Moving videos to appropriate categories...")
    move_videos_to_categories(video_paths, cluster_labels)

if __name__ == '__main__':
    try:
        organize_mixed_folder()
    except Exception as e:
        import traceback
        traceback.print_exc()
        sys.exit(1)
