const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const app = express();
const AWS = require('aws-sdk');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const Audio = require('./models/Audio');

const User = require('./models/User');
const Otp = require('./models/Otp');

AWS.config.update({
    region: 'eu-north-1'
});
const polly = new AWS.Polly();

// const gtts= require('gtts');
require('dotenv').config();
const PORT = process.env.PORT || 3000;
// Cloudinary
const cloudinary = require('cloudinary').v2;
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});
// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_123';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const authMiddleware = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ message: 'Invalid token' });
    }
};



// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

//MongoDB connection 
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB error:', err));

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

transporter.verify((error) => {
    if (error) {
        console.log("Nodemailer Error:", error);
    } else {
        console.log("Email service ready");
    }
});
const generateToken = (user) => {
    return jwt.sign(
        { id: user._id, email: user.email },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
};


// Send OTP
app.post('/api/send-otp', async (req, res) => {
    try {
        const { email } = req.body;

        if (await User.findOne({ email })) {
            return res.status(400).json({ message: 'User already exists' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await Otp.findOneAndUpdate(
            { email },
            { email, otp },
            { upsert: true }
        );

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Your Verification Code',
            text: `Your OTP is ${otp}`
        });

        res.json({ message: 'OTP sent successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/verify-otp-register', async (req, res) => {
    try {
        const { email, password, otp } = req.body;

        const record = await Otp.findOne({ email, otp });
        if (!record) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ email, password: hashedPassword });

        await Otp.deleteOne({ _id: record._id });

        res.json({
            token: generateToken(user),
            user: { id: user._id, email: user.email }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user || !user.password) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid credentials' });
        }

        res.json({
            token: generateToken(user),
            user: { id: user._id, email: user.email }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/auth/google', async (req, res) => {
    try {
        const client = new OAuth2Client(GOOGLE_CLIENT_ID);
        const ticket = await client.verifyIdToken({
            idToken: req.body.idToken,
            audience: GOOGLE_CLIENT_ID
        });

        const { email, sub } = ticket.getPayload();

        let user = await User.findOne({ email });
        if (!user) {
            user = await User.create({ email, googleId: sub });
        }

        res.json({
            token: generateToken(user),
            user: { id: user._id, email: user.email }
        });
    } catch (err) {
        res.status(500).json({ message: 'Google auth failed' });
    }
});

// Multer configuration for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        // Keep original filename
        const baseName = path.parse(file.originalname).name;
        cb(null, `${baseName}${Date.now()}`);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: function (req, file, cb) {
        // Relaxed filter: Accept audio types OR generic binary streams (common from mobile apps)
        if (file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream') {
            cb(null, true);
        } else {
            // Just log it so you know why it failed
            console.log('Rejected file type:', file.mimetype);
            cb(new Error('Only audio files are allowed!'), false);
        }
    },
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

// Serve static files (uploaded audio files)
app.use('/audio', express.static(uploadsDir));

// Serve admin panel static files
app.use(express.static(path.join(__dirname, 'public')));

// API Routes

// Get list of available audio tracks
app.get('/api/tracks', (req, res) => {
    try {
        const files = fs.readdirSync(uploadsDir);
        const audioFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.mp3', '.wav', '.m4a', '.flac'].includes(ext);
        });
        res.json(audioFiles);
    } catch (error) {
        console.error('Error reading uploads directory:', error);
        res.status(500).json({ error: 'Failed to read audio files' });
    }
});

//TEXT TO SPEECH ENDPOINT



app.post('/api/text-to-audio', authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const timestamp = Date.now();
        const filePath = path.join(uploadsDir, `tts_${timestamp}.mp3`);

        const params = {
            Text: text,
            OutputFormat: 'mp3',
            VoiceId: 'Joanna',   // Natural female English voice
            Engine: 'standard'
        };

        const audio = await polly.synthesizeSpeech(params).promise();

        fs.writeFileSync(filePath, audio.AudioStream);
        await Audio.create({
            userId: req.user.id,
            filename: `tts_${timestamp}.mp3`,
            type: 'tts'
        });


        res.json({
            message: 'Audio generated successfully',
            audioUrl: `/audio/tts_${timestamp}.mp3`
        });

    } catch (err) {
        console.error('Polly error:', err);
        res.status(500).json({ error: 'Audio generation failed' });
    }
});

// Upload audio file
// Upload audio file
app.post('/api/upload', authMiddleware, upload.single('audioFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Compressing the audio file
        const inputPath = req.file.path;
        // Note: req.file.filename does not have the extension here based on your multer config
        const outputPath = path.join(uploadsDir, `${req.file.filename}.mp3`);

        ffmpeg(inputPath)
            .audioBitrate('96k')
            .audioChannels(1)
            .audioFrequency(44100)
            .audioFilters([
                'highpass=f=200',   // 1. Remove bass (waste of energy)
                'dynaudnorm=f=150:g=15'
            ])
            .format('mp3')
            .on('end', async () => {

                // --- NEW CODE: Get final size and print logs ---
                const initialSize = req.file.size;
                const finalStats = fs.statSync(outputPath);
                const finalSize = finalStats.size;

                console.log(`--- Compression Results ---`);
                console.log(`File: ${req.file.originalname}`);
                console.log(`Initial Size: ${(initialSize / 1024).toFixed(2)} KB`);
                console.log(`Final Size:   ${(finalSize / 1024).toFixed(2)} KB`);
                console.log(`Reduction:    ${((1 - finalSize / initialSize) * 100).toFixed(2)}%`);
                console.log(`---------------------------`);
                // ---------------------------------------------

                fs.unlinkSync(inputPath); // Delete the uncompressed upload
                await Audio.create({
                    userId: req.user.id,
                    filename: path.basename(outputPath),
                    type: 'upload'
                });

                res.json({
                    message: 'File uploaded successfully',
                    originalName: req.file.originalname,
                    compressedFile: `${req.file.filename}.mp3`,
                    uploadTime: new Date().toISOString(),
                    // Optional: Send sizes back to the client as well
                    initialSizeBytes: initialSize,
                    finalSizeBytes: finalSize
                });
            })
            .on('error', (err) => {
                console.error("FFmpeg error:", err);
                // Ensure we try to clean up the temp file even on error
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                res.status(500).json({ error: 'Compression failed' });
            })
            .save(outputPath);

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.get('/api/my-audios', authMiddleware, async (req, res) => {
    const audios = await Audio.find({ userId: req.user.id });
    res.json(audios);
});
// Delete audio file
app.delete('/api/tracks/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        const filepath = path.join(uploadsDir, filename);

        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            res.json({ message: 'File deleted successfully' });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Get file info
app.get('/api/tracks/:filename/info', (req, res) => {
    try {
        const filename = req.params.filename;
        const filepath = path.join(uploadsDir, filename);

        if (fs.existsSync(filepath)) {
            const stats = fs.statSync(filepath);
            res.json({
                filename: filename,
                size: stats.size,
                createdAt: stats.birthtime,
                modifiedAt: stats.mtime
            });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (error) {
        console.error('File info error:', error);
        res.status(500).json({ error: 'Failed to get file info' });
    }
});

// Serve admin panel
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large' });
        }
    }
    res.status(500).json({ error: error.message });
});



app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://13.60.68.202:${PORT}`);
    console.log(`Admin panel available at http://localhost:${PORT}`);
    console.log(`Upload directory: ${uploadsDir}`);
});






