from flask import Flask, render_template, request, jsonify, Response, send_from_directory
import yt_dlp
import os
import shutil
import json
import uuid
import time
import threading
from queue import Queue, Empty

app = Flask(__name__)
app.config['DOWNLOADS_DIR'] = os.path.join(app.root_path, 'downloads')
os.makedirs(app.config['DOWNLOADS_DIR'], exist_ok=True)

download_queues = {}
queue_lock = threading.Lock()

def get_ffmpeg_path():
    # 1. System PATH
    system_ffmpeg = shutil.which('ffmpeg')
    if system_ffmpeg:
        return system_ffmpeg
    # 2. Bundled imageio_ffmpeg
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        pass
    return None

def get_safe_filepath(filename):
    clean_filename = os.path.basename(filename)
    filepath = os.path.join(app.config['DOWNLOADS_DIR'], clean_filename)
    return filepath, clean_filename

def cleanup_old_downloads(max_age_seconds=3600):
    try:
        now = time.time()
        for fname in os.listdir(app.config['DOWNLOADS_DIR']):
            fpath = os.path.join(app.config['DOWNLOADS_DIR'], fname)
            if os.path.isfile(fpath) and (now - os.path.getmtime(fpath)) > max_age_seconds:
                try:
                    os.remove(fpath)
                except Exception:
                    pass
    except Exception:
        pass

def get_video_formats(video_url):
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True
    }
    ffmpeg_path = get_ffmpeg_path()
    if ffmpeg_path:
        ydl_opts['ffmpeg_location'] = ffmpeg_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.sanitize_info(ydl.extract_info(video_url, download=False))
            formats = []
            seen = set()
            
            raw_formats = info.get('formats', [])
            for f in raw_formats:
                if f.get('vcodec') != 'none':  # Video stream
                    height = f.get('height')
                    ext = f.get('ext', 'mp4')
                    filesize = f.get('filesize') or f.get('filesize_approx') or 0
                    
                    res_display = height if (isinstance(height, int) and height > 0) else 'Unknown'
                    key = (res_display, ext)
                    if key not in seen and res_display != 'Unknown':
                        seen.add(key)
                        formats.append({
                            'format_id': str(f.get('format_id', '')),
                            'resolution': res_display,
                            'ext': ext,
                            'filesize': filesize,
                            'is_audio': False
                        })

            sorted_formats = sorted(
                formats,
                key=lambda x: (x['resolution'] if isinstance(x['resolution'], int) else 0),
                reverse=True
            )

            # Audio-only download option
            has_audio = any(f.get('acodec') != 'none' for f in raw_formats)
            if has_audio:
                sorted_formats.append({
                    'format_id': 'bestaudio',
                    'resolution': 'Audio Only',
                    'ext': 'mp3',
                    'filesize': 0,
                    'is_audio': True
                })

            return {
                'title': info.get('title', 'Video'),
                'formats': sorted_formats,
                'thumbnail': info.get('thumbnail', '')
            }
    except Exception as e:
        return {'error': f'Failed to process video: {str(e)}'}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/get_formats', methods=['POST'])
def get_formats():
    data = request.get_json() or {}
    video_url = data.get('url', '').strip()
    if not video_url:
        return jsonify({'error': 'Please enter a valid URL'}), 400
    res = get_video_formats(video_url)
    if 'error' in res:
        return jsonify(res), 400
    return jsonify(res)

@app.route('/download', methods=['POST'])
def download():
    cleanup_old_downloads()
    data = request.get_json() or {}
    video_url = data.get('url', '').strip()
    format_id = data.get('format_id', '').strip()
    
    if not video_url or not format_id:
        return jsonify({'error': 'Invalid request'}), 400

    download_id = str(uuid.uuid4())
    progress_queue = Queue()
    with queue_lock:
        download_queues[download_id] = progress_queue

    def progress_hook(d):
        if d['status'] == 'downloading':
            progress_queue.put({
                'percent': d.get('_percent_str', '0.0%'),
                'speed': d.get('_speed_str', 'N/A'),
                'eta': d.get('_eta_str', 'N/A')
            })

    def download_task():
        try:
            ffmpeg_path = get_ffmpeg_path()
            outtmpl = os.path.join(app.config['DOWNLOADS_DIR'], '%(title).100s.%(ext)s')
            
            ydl_opts = {
                'outtmpl': outtmpl,
                'windowsfilenames': True,
                'noprogress': False,
                'concurrent_fragment_downloads': 5,
                'retries': 10,
                'fragment_retries': 10,
                'socket_timeout': 30,
                'http_chunk_size': 10485760,
                'progress_hooks': [progress_hook],
            }

            if ffmpeg_path:
                ydl_opts['ffmpeg_location'] = ffmpeg_path

            if format_id == 'bestaudio':
                ydl_opts['format'] = 'bestaudio/best'
                if ffmpeg_path:
                    ydl_opts['postprocessors'] = [{
                        'key': 'FFmpegExtractAudio',
                        'preferredcodec': 'mp3',
                        'preferredquality': '192',
                    }]
            elif ffmpeg_path:
                # Video + Audio merged into MP4 container
                ydl_opts['format'] = f'{format_id}+bestaudio/best'
                ydl_opts['merge_output_format'] = 'mp4'
            else:
                ydl_opts['format'] = f'{format_id}/best'

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(video_url, download=True)
                
                final_file = None
                if info.get('requested_downloads') and len(info['requested_downloads']) > 0:
                    final_file = info['requested_downloads'][0].get('filepath')

                if not final_file or not os.path.exists(final_file):
                    prepared = ydl.prepare_filename(info)
                    if os.path.exists(prepared):
                        final_file = prepared
                    else:
                        base_path, _ = os.path.splitext(prepared)
                        for cand_ext in ['.mp4', '.mp3', '.mkv', '.webm']:
                            if os.path.exists(base_path + cand_ext):
                                final_file = base_path + cand_ext
                                break

                if not final_file or not os.path.exists(final_file):
                    raise FileNotFoundError("Merged download file could not be located on disk.")

                basename = os.path.basename(final_file)
                progress_queue.put({
                    'status': 'complete',
                    'download_url': f'/downloads/{basename}',
                    'filename': basename
                })
        except Exception as e:
            progress_queue.put({'error': str(e)})
        finally:
            with queue_lock:
                if download_id in download_queues:
                    del download_queues[download_id]

    threading.Thread(target=download_task, daemon=True).start()
    return jsonify({'download_id': download_id})

@app.route('/progress/<download_id>')
def progress(download_id):
    def generate():
        with queue_lock:
            queue = download_queues.get(download_id)
        
        if not queue:
            yield 'data: {"error": "Invalid download ID"}\n\n'
            return
            
        while True:
            try:
                progress = queue.get(timeout=60)
                yield f"data: {json.dumps(progress)}\n\n"
                if 'error' in progress or 'status' in progress:
                    break
            except Empty:
                break
                
    return Response(generate(), mimetype='text/event-stream')

@app.route('/downloads/<path:filename>', methods=['GET', 'DELETE'])
@app.route('/mobile_download/<path:filename>', methods=['GET', 'DELETE'])
def serve_or_delete_download(filename):
    filepath, clean_name = get_safe_filepath(filename)
    
    if request.method == 'DELETE':
        try:
            if os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except PermissionError:
                    # File handle still being streamed on Windows; will be cleaned up by background cleaner
                    pass
            return jsonify({'status': 'success', 'message': 'File handled'}), 200
        except Exception as e:
            return jsonify({'status': 'error', 'message': str(e)}), 500

    try:
        response = send_from_directory(
            app.config['DOWNLOADS_DIR'],
            clean_name,
            as_attachment=True,
            conditional=True
        )
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        return response
    except FileNotFoundError:
        return jsonify({'error': 'File not found'}), 404

if __name__ == '__main__':
    cleanup_old_downloads()
    app.run(debug=True)