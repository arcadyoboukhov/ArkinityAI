#!/usr/bin/env python3
"""
Diagnostic script to test deep learning indexer
Run this to identify why indexing stops immediately
"""
import subprocess
import sys
import os
import json

def test_python():
    """Test if Python is accessible"""
    print("🔍 Testing Python...")
    result = subprocess.run([sys.executable, '--version'], capture_output=True, text=True)
    print(f"   Python version: {result.stdout.strip()}")
    return True

def test_script_exists():
    """Check if our script exists"""
    print("🔍 Checking if deep learning script exists...")
    script_path = os.path.join(os.path.dirname(__file__), 'deep_learning_processor.py')
    if os.path.isfile(script_path):
        print(f"   ✅ Found: {script_path}")
        return script_path
    else:
        print(f"   ❌ NOT FOUND: {script_path}")
        return None

def test_check_deps(script_path):
    """Test the --check-deps flag"""
    print("\n🔍 Testing dependency check...")
    result = subprocess.run(
        [sys.executable, script_path, '--check-deps'],
        capture_output=True,
        text=True,
        timeout=30
    )
    
    print("STDOUT:")
    for line in result.stdout.split('\n'):
        if line.strip():
            try:
                obj = json.loads(line)
                print(f"   {obj}")
            except:
                print(f"   {line}")
    
    if result.stderr.strip():
        print("STDERR:")
        for line in result.stderr.split('\n'):
            if line.strip():
                print(f"   {line}")
    
    print(f"   Exit code: {result.returncode}")
    return result.returncode == 0

def test_with_sample_folder(script_path, test_folder, output_file):
    """Test indexing with a sample folder"""
    print(f"\n🔍 Testing indexing with {test_folder}...")
    
    if not os.path.isdir(test_folder):
        print(f"   ⚠️  Folder does not exist: {test_folder}")
        return False
    
    videos = [f for f in os.listdir(test_folder) if f.lower().endswith(('.mp4', '.mov', '.mkv', '.avi'))]
    print(f"   Found {len(videos)} video(s)")
    
    if len(videos) == 0:
        print("   ⚠️  No videos in folder to test")
        return False
    
    print(f"   Testing with --check-deps first...")
    result = subprocess.run(
        [sys.executable, script_path, 
         '--video-dir', test_folder,
         '--output', output_file,
         '--ffmpeg', 'ffmpeg',  # Will be resolved
         '--quality', 'fast'],
        capture_output=True,
        text=True,
        timeout=120
    )
    
    lines_out = result.stdout.split('\n')
    lines_err = result.stderr.split('\n')
    
    print(f"   STDOUT ({len(lines_out)} lines):")
    for line in lines_out[:10]:  # First 10 lines
        if line.strip():
            try:
                obj = json.loads(line)
                print(f"      type={obj.get('type')}: {str(obj)[:100]}")
            except:
                print(f"      {line[:100]}")
    
    if len(lines_out) > 10:
        print(f"      ... ({len(lines_out)-10} more lines)")
    
    if result.stderr.strip():
        print(f"   STDERR:")
        for line in lines_err[:5]:
            if line.strip():
                print(f"      {line}")
    
    print(f"   Exit code: {result.returncode}")
    return result.returncode == 0

if __name__ == '__main__':
    print("=" * 70)
    print("Arcinity Deep Learning Indexer - Diagnostic Test")
    print("=" * 70)
    
    try:
        test_python()
        script_path = test_script_exists()
        
        if script_path:
            if test_check_deps(script_path):
                print("\n✅ Dependencies OK")
                
                # Try testing with a real folder if user provides it
                if len(sys.argv) > 1:
                    test_folder = sys.argv[1]
                    output_file = sys.argv[2] if len(sys.argv) > 2 else '/tmp/test_index.json'
                    test_with_sample_folder(script_path, test_folder, output_file)
            else:
                print("\n❌ Dependencies failed")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
