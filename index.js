const fs = require('fs');
const fsPromises = require('fs').promises;
const mkfifo = require('mkfifo');
const express = require('express');
const cors = require('cors')
const ffmpeg = require('fluent-ffmpeg')

const privateKey = fs.readFileSync('sslcert/server.key', 'utf8');
const certificate = fs.readFileSync('sslcert/server.crt', 'utf8');
const credentials = {key: privateKey, cert: certificate};

const app = express()
app.use(cors())
app.use(express.static('media'))

app.get('/share/:id(\\d+)/', (req, res) => {
    res.sendFile(__dirname + '/share.html');
});
app.get('/get/:id(\\d+)/', (req, res) => {
    if (fs.existsSync('media/' + req.params.id)) {
        res.sendFile(__dirname + '/get.html');
    } else {
        res.status(404)
        res.send('No such stream')
    }
});

const http = require('http').createServer(app);
const https = require('https').createServer(credentials, app);
const io = require('socket.io')(https, {cors: {origin: "*"}});

io.on('connection', socket => {
    let fd = -1;
    let ffmpegPromise = null;
    let videoStreamPath = '';

    const startStream = async streamId => {
        videoStreamPath = 'media/' + streamId;
        if (fs.existsSync(videoStreamPath)) {
            socket.once('start', startStream);
            socket.emit('start', 'exists');
        } else {
            fs.mkdirSync(videoStreamPath);
            mkfifo.mkfifoSync(videoStreamPath + '/stream.webm', 0o600);

            const fdPromise = fsPromises.open(videoStreamPath + '/stream.webm', 'w');

            ffmpegPromise = new Promise((resolve, reject) => {
                ffmpeg(videoStreamPath + '/stream.webm')
                    .addOptions([
                        '-preset veryfast',
                        '-start_number 0',
                        '-hls_time 1',
                        '-hls_list_size 0',
                        '-g 5',
                        '-sc_threshold 0',
                        '-f hls',
                        '-hls_flags append_list',
                    ])
                    .output(videoStreamPath + '/index.m3u8')
                    .on('end', resolve)
                    .on('error', err => {
                        return reject(new Error(err))
                    })
                    .run();
            });

            try {
                fd = await fdPromise;
            } catch (e) {
                socket.once('start', startStream);
                socket.emit('start', e);
            }

            socket.on('package', msg => {
                if (fd !== -1) {
                    fd.write(msg).catch(() => {
                    });
                }
            });

            socket.once('stop', stopStream);

            socket.emit('started');
        }
    }

    const stopStream = async (closingConnection = false) => {
        if (fd === -1) {
            if (!closingConnection) {
                socket.emit('stop', 'not started');
            }
        } else {
            try {
                socket.removeAllListeners('message');
                await fd.close();
                fd = -1
                await ffmpegPromise;
                fs.unlinkSync(videoStreamPath + '/stream.webm');
            } catch (e) {
                if (!closingConnection) {
                    socket.once('stop', stopStream);

                    socket.emit('stop', e);
                }
            }

            if (!closingConnection) {
                socket.once('start', startStream);

                socket.emit('stopped');
            }
        }
    };

    socket.once('start', startStream);

    socket.once('disconnect', async () => stopStream(true));
});

http.listen(80, () => {
    console.log('listening on *:80');
});
https.listen(443, () => {
    console.log('listening on *:443');
});