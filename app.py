from flask import Flask, render_template, request, jsonify, Response, send_from_directory
import yt_dlp
import os
import json
import uuid
import threading
from queue import Queue, Empty

app = Flask(__name__)
app.config['DOWNLOADS_DIR'] = os.path.join(app.root_path, 'downloads')
os.makedirs(app.config['DOWNLOADS_DIR'], exist_ok=True)

download_queues = {}
queue_lock = threading.Lock()

def get_video_formats(video_url):
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.sanitize_info(ydl.extract_info(video_url, download=False))
            formats = []
            seen = set()
            
            for f in info['formats']:
                if f.get('vcodec') != 'none':  # Exclude audio-only
                    key = (f.get('height'), f.get('ext'))
                    if key not in seen:
                        seen.add(key)
                        formats.append({
                            'format_id': f['format_id'],
                            'resolution': f.get('height', 'Unknown'),
                            'ext': f.get('ext', 'mp4'),
                            'filesize': f.get('filesize', 0)
                        })
            return {
                'formats': sorted(formats, key=lambda x: x['resolution'], reverse=True),
                'thumbnail': info.get('thumbnail', '')
            }
    except Exception as e:
        return {'error': f'Failed to process video: {str(e)}'}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/get_formats', methods=['POST'])
def get_formats():
    data = request.get_json()
    video_url = data.get('url', '').strip()
    if not video_url:
        return jsonify({'error': 'Please enter a valid URL'}), 400
    return jsonify(get_video_formats(video_url))

@app.route('/download', methods=['POST'])
def download():
    data = request.get_json()
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
            ydl_opts = {
                'format': f'{format_id}+bestaudio/best',
                'outtmpl': os.path.join(app.config['DOWNLOADS_DIR'], '%(title)s.%(ext)s'),
                'noprogress': False,
                'concurrent_fragment_downloads': 5,
                'retries': 10,
                'fragment_retries': 10,
                'socket_timeout': 30,
                'http_chunk_size': 10485760,
                'progress_hooks': [progress_hook],
                'merge_output_format': 'mp4',
                'postprocessors': [{
                    'key': 'FFmpegVideoConvertor',
                    'preferedformat': 'mp4'
                }]
            }

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(video_url, download=True)
                filename = ydl.prepare_filename(info)
                progress_queue.put({
                    'status': 'complete',
                    'download_url': f'/downloads/{os.path.basename(filename)}'
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

@app.route('/downloads/<filename>')
def serve_download(filename):
    try:
        return send_from_directory(
            app.config['DOWNLOADS_DIR'],
            filename,
            as_attachment=True,
            conditional=True
        )
    except FileNotFoundError:
        return jsonify({'error': 'File not found'}), 404

@app.route('/mobile_download/<path:filename>')
def mobile_download(filename):
    try:
        response = send_from_directory(
            app.config['DOWNLOADS_DIR'],
            filename,
            as_attachment=True,
            conditional=True
        )
        # Mobile-friendly headers to prevent caching and ensure download
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Content-Disposition'] = f'attachment; filename="{filename}"'
        return response
    except FileNotFoundError:
        return jsonify({'error': 'File not found'}), 404

if __name__ == '__main__':
    app.run(debug=True)