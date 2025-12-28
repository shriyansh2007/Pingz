const mongoose = require('mongoose');

const audioSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  filename: String,
  type: {
    type: String, // upload | tts
    enum: ['upload', 'tts']
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Audio', audioSchema);
