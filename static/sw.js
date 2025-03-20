self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open('video-dl').then(cache => {
            return cache.addAll([
                '/',
                '/static/styles.css',
                '/static/script.js',
                'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
            ]);
        })
    );
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then(response => {
            return response || fetch(e.request);
        })
    );
});