from flask import Flask, render_template, request, jsonify, Response, send_from_directory
import yt_dlp
import os
import re
import shutil
import json
import uuid
import time
import threading
import urllib.parse

ANSI_REGEX = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]')

def clean_ansi(text):
    if not text:
        return ""
    return ANSI_REGEX.sub('', str(text)).strip()

app = Flask(__name__)
app.config['DOWNLOADS_DIR'] = os.path.join(app.root_path, 'downloads')
os.makedirs(app.config['DOWNLOADS_DIR'], exist_ok=True)

# State Store: Persistent job states for dual SSE + Polling synchronization
download_jobs = {}
job_lock = threading.Lock()

def update_job(job_id, **kwargs):
    with job_lock:
        if job_id not in download_jobs:
            download_jobs[job_id] = {
                'id': job_id,
                'status': 'starting',
                'percent': '0.0%',
                'percent_num': 0.0,
                'speed': 'Connecting...',
                'eta': 'Starting...',
                'status_text': 'Initializing stream...',
                'download_url': None,
                'filename': None,
                'error': None,
                'created_at': time.time(),
                'updated_at': time.time()
            }
        download_jobs[job_id].update(kwargs)
        download_jobs[job_id]['updated_at'] = time.time()

def cleanup_stale_jobs():
    with job_lock:
        now = time.time()
        to_del = [jid for jid, j in download_jobs.items() if now - j.get('updated_at', 0) > 1800]
        for jid in to_del:
            del download_jobs[jid]

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
    clean_filename = os.path.basename(urllib.parse.unquote(filename))
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

def format_duration(seconds):
    if not seconds:
        return ""
    try:
        s = int(seconds)
        m, s = divmod(s, 60)
        h, m = divmod(m, 60)
        if h > 0:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m:02d}:{s:02d}"
    except Exception:
        return ""

def format_number(num):
    if not num:
        return ""
    try:
        n = int(num)
        if n >= 1_000_000:
            return f"{n / 1_000_000:.1f}M"
        if n >= 1_000:
            return f"{n / 1_000:.1f}K"
        return str(n)
    except Exception:
        return ""

def get_quality_badge(height):
    try:
        h = int(height)
        if h >= 2160:
            return "4K Ultra HD"
        if h >= 1440:
            return "2K QHD"
        if h >= 1080:
            return "Full HD"
        if h >= 720:
            return "HD"
        if h >= 480:
            return "Standard"
        return "Fast"
    except Exception:
        return "Standard"

def get_video_formats(video_url):
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
        'nocolor': True,
        'no_color': True,
    }
    ffmpeg_path = get_ffmpeg_path()
    if ffmpeg_path:
        ydl_opts['ffmpeg_location'] = ffmpeg_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.sanitize_info(ydl.extract_info(video_url, download=False))
            video_formats = []
            audio_formats = []
            seen_res = set()
            
            raw_formats = info.get('formats', []) or []
            for f in raw_formats:
                if f.get('vcodec') != 'none':
                    height = f.get('height')
                    ext = f.get('ext', 'mp4')
                    filesize = f.get('filesize') or f.get('filesize_approx') or 0
                    
                    if isinstance(height, int) and height > 0:
                        if height not in seen_res:
                            seen_res.add(height)
                            video_formats.append({
                                'format_id': str(f.get('format_id', '')),
                                'resolution': height,
                                'badge': get_quality_badge(height),
                                'ext': 'MP4',
                                'fps': f.get('fps'),
                                'filesize': filesize,
                                'is_audio': False
                            })

            sorted_video = sorted(video_formats, key=lambda x: x['resolution'], reverse=True)

            has_audio = any(f.get('acodec') != 'none' for f in raw_formats)
            if has_audio or len(sorted_video) > 0:
                audio_formats = [
                    {
                        'format_id': 'audio_mp3_320',
                        'resolution': '320 kbps',
                        'badge': 'Studio HQ',
                        'ext': 'MP3',
                        'filesize': 0,
                        'is_audio': True
                    },
                    {
                        'format_id': 'audio_mp3_192',
                        'resolution': '192 kbps',
                        'badge': 'High Quality',
                        'ext': 'MP3',
                        'filesize': 0,
                        'is_audio': True
                    },
                    {
                        'format_id': 'audio_m4a',
                        'resolution': 'AAC Lossless',
                        'badge': 'Original',
                        'ext': 'M4A',
                        'filesize': 0,
                        'is_audio': True
                    }
                ]

            return {
                'title': info.get('title', 'Video Media'),
                'thumbnail': info.get('thumbnail', ''),
                'duration': format_duration(info.get('duration')),
                'uploader': info.get('uploader') or info.get('channel') or '',
                'views': format_number(info.get('view_count')),
                'platform': info.get('extractor_key', 'Media'),
                'video_formats': sorted_video,
                'audio_formats': audio_formats
            }
    except Exception as e:
        return {'error': f'Failed to analyze media: {str(e)}'}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/get_formats', methods=['POST'])
def get_formats():
    data = request.get_json() or {}
    video_url = data.get('url', '').strip()
    if not video_url:
        return jsonify({'error': 'Please enter a valid media URL'}), 400
    res = get_video_formats(video_url)
    if 'error' in res:
        return jsonify(res), 400
    return jsonify(res)

@app.route('/download', methods=['POST'])
def download():
    cleanup_old_downloads()
    cleanup_stale_jobs()
    data = request.get_json() or {}
    video_url = data.get('url', '').strip()
    format_id = data.get('format_id', '').strip()
    
    if not video_url or not format_id:
        return jsonify({'error': 'Invalid request parameters'}), 400

    download_id = str(uuid.uuid4())
    update_job(
        download_id,
        status='starting',
        status_text='Connecting to media stream...',
        percent='0.0%',
        percent_num=0.0
    )

    def progress_hook(d):
        status = d.get('status')
        if status == 'downloading':
            downloaded = d.get('downloaded_bytes') or 0
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0

            if total > 0:
                pct_num = min(99.0, max(0.1, (downloaded / total) * 100))
                pct_str = f"{pct_num:.1f}%"
            else:
                raw_pct = clean_ansi(d.get('_percent_str', ''))
                m = re.search(r'(\d+(?:\.\d+)?)', raw_pct)
                if m:
                    pct_num = min(99.0, max(0.1, float(m.group(1))))
                    pct_str = f"{pct_num:.1f}%"
                else:
                    pct_num = 1.0
                    pct_str = "1.0%"

            speed_val = d.get('speed')
            if speed_val and speed_val > 0:
                if speed_val >= 1024 * 1024:
                    speed_str = f"{speed_val / (1024 * 1024):.2f} MB/s"
                elif speed_val >= 1024:
                    speed_str = f"{speed_val / 1024:.1f} KB/s"
                else:
                    speed_str = f"{speed_val:.0f} B/s"
            else:
                raw_speed = clean_ansi(d.get('_speed_str', ''))
                speed_str = raw_speed if raw_speed else "Downloading..."

            eta_val = d.get('eta')
            if eta_val is not None:
                try:
                    eta_sec = int(eta_val)
                    m, s = divmod(eta_sec, 60)
                    h, m = divmod(m, 60)
                    if h > 0:
                        eta_str = f"{h}h {m:02d}m {s:02d}s"
                    elif m > 0:
                        eta_str = f"{m}m {s:02d}s"
                    else:
                        eta_str = f"{s}s"
                except Exception:
                    eta_str = clean_ansi(d.get('_eta_str', ''))
            else:
                eta_str = clean_ansi(d.get('_eta_str', ''))

            fname = d.get('filename') or ''
            if any(k in fname for k in ['.f251', '.f140', '.m4a', 'audio']):
                stage_text = "Downloading audio stream..."
            else:
                stage_text = "Downloading video stream..."

            update_job(
                download_id,
                status='downloading',
                percent=pct_str,
                percent_num=round(pct_num, 1),
                speed=speed_str,
                eta=eta_str or "Optimizing...",
                status_text=stage_text
            )
        elif status == 'finished':
            update_job(
                download_id,
                status='processing',
                percent='99.0%',
                percent_num=99.0,
                speed='Merging',
                eta='Almost done...',
                status_text='Merging audio and video tracks into MP4...'
            )

    def postprocessor_hook(d):
        if d.get('status') == 'started':
            update_job(
                download_id,
                status='processing',
                percent='99.0%',
                percent_num=99.0,
                speed='Remuxing',
                eta='Finishing up...',
                status_text='Encoding and finalizing container format...'
            )

    def download_task():
        try:
            ffmpeg_path = get_ffmpeg_path()
            outtmpl = os.path.join(app.config['DOWNLOADS_DIR'], '%(title).80s.%(ext)s')
            
            # High-performance, throttled-free yt-dlp configuration
            ydl_opts = {
                'outtmpl': outtmpl,
                'windowsfilenames': True,
                'restrictfilenames': True,  # Ensures safe ASCII filenames across OS and HTTP URLs
                'noprogress': False,
                'nocolor': True,
                'no_color': True,
                'retries': 10,
                'fragment_retries': 10,
                'socket_timeout': 30,
                'progress_hooks': [progress_hook],
                'postprocessor_hooks': [postprocessor_hook],
            }

            if ffmpeg_path:
                ydl_opts['ffmpeg_location'] = ffmpeg_path

            if format_id.startswith('audio_') or format_id == 'bestaudio':
                ydl_opts['format'] = 'bestaudio/best'
                if ffmpeg_path:
                    if format_id == 'audio_m4a':
                        ydl_opts['postprocessors'] = [{
                            'key': 'FFmpegExtractAudio',
                            'preferredcodec': 'm4a',
                        }]
                    else:
                        bitrate = '320' if '320' in format_id else '192'
                        ydl_opts['postprocessors'] = [{
                            'key': 'FFmpegExtractAudio',
                            'preferredcodec': 'mp3',
                            'preferredquality': bitrate,
                        }]
            elif ffmpeg_path:
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
                        for cand_ext in ['.mp4', '.mp3', '.m4a', '.mkv', '.webm']:
                            if os.path.exists(base_path + cand_ext):
                                final_file = base_path + cand_ext
                                break

                if not final_file or not os.path.exists(final_file):
                    raise FileNotFoundError("Merged download file could not be located on disk.")

                basename = os.path.basename(final_file)
                safe_download_url = f'/downloads/{urllib.parse.quote(basename)}'
                
                update_job(
                    download_id,
                    status='complete',
                    percent='100.0%',
                    percent_num=100.0,
                    status_text='Ready for playback!',
                    download_url=safe_download_url,
                    filename=basename
                )
        except Exception as e:
            update_job(
                download_id,
                status='error',
                error=str(e),
                status_text=f"Error: {str(e)}"
            )

    threading.Thread(target=download_task, daemon=True).start()
    return jsonify({'download_id': download_id})

@app.route('/progress/<download_id>')
def progress(download_id):
    def generate():
        last_percent = None
        last_status = None
        start = time.time()
        while time.time() - start < 600:
            with job_lock:
                job = download_jobs.get(download_id)
            
            if job:
                if job['percent_num'] != last_percent or job['status'] != last_status or job['status'] in ('complete', 'error'):
                    last_percent = job['percent_num']
                    last_status = job['status']
                    yield f"data: {json.dumps(job)}\n\n"
                    
                    if job['status'] in ('complete', 'error'):
                        break
            time.sleep(0.3)

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }
    )

@app.route('/status/<download_id>')
def job_status(download_id):
    with job_lock:
        job = download_jobs.get(download_id)
    if not job:
        return jsonify({'status': 'not_found', 'error': 'Download session expired'}), 404
    return jsonify(job)

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