const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// YouTube API key
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

/**
 * Main endpoint to fetch short YouTube videos about AI tools
 * from channels with at least 1,000 subscribers
 * with optional time filter (lastHours)
 */
app.get('/api/ai-tools-videos', async (req, res) => {
  try {
    // Get query parameters with defaults
    const {
      maxResults = 10,
      maxDuration = 1200, // 20 minutes in seconds
      minSubscribers = 1000,
      page = '',
      lastHours = null  // New parameter for filtering by time
    } = req.query;

    // Search parameters
    const searchParams = {
      part: 'snippet',
      q: 'new AI tools OR "new AI tool"',  // Include both singular and plural
      type: 'video',
      maxResults: 50,  // Get more results to have a better chance of finding recent ones
      pageToken: page || '',
      order: 'date', // Sort by date
      key: YOUTUBE_API_KEY
    };

    // If lastHours is provided, add publishedAfter parameter
    if (lastHours) {
      const publishedAfter = new Date();
      publishedAfter.setHours(publishedAfter.getHours() - parseInt(lastHours));
      searchParams.publishedAfter = publishedAfter.toISOString();
      console.log('Searching for videos after:', publishedAfter.toISOString());
    }

    // Search for videos related to AI tools
    const searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: searchParams
    });

    console.log(`Found ${searchResponse.data.items.length} videos in search`);

    // Extract video IDs for further processing
    const videoIds = searchResponse.data.items.map(item => item.id.videoId).join(',');
    
    // If no videos found, return empty result
    if (!videoIds) {
      return res.json({
        videos: [],
        nextPageToken: null,
        pageInfo: { totalResults: 0, resultsPerPage: 0 },
        totalResults: 0,
        message: `No videos found in the last ${lastHours} hours`
      });
    }
    
    // Get detailed info for these videos (including duration)
    const videoDetailsResponse = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'contentDetails,snippet,statistics',
        id: videoIds,
        key: YOUTUBE_API_KEY
      }
    });

    // Filter videos by duration
    const filteredVideos = [];
    const channelIds = new Set();
    
    videoDetailsResponse.data.items.forEach(video => {
      try {
        // Parse duration (PT1H2M3S format)
        const duration = video.contentDetails.duration;
        const seconds = parseDuration(duration);
        
        // If we couldn't parse duration, skip this video
        if (seconds === null) {
          console.log(`Skipping video ${video.id} - couldn't parse duration`);
          return;
        }
        
        // Double-check the date if lastHours is provided
        let includeVideo = true;
        if (lastHours) {
          const videoDate = new Date(video.snippet.publishedAt);
          const cutoffDate = new Date();
          cutoffDate.setHours(cutoffDate.getHours() - parseInt(lastHours));
          
          if (videoDate < cutoffDate) {
            includeVideo = false;
          }
        }
        
        // Keep only videos under maxDuration and within time limit
        if (seconds <= maxDuration && includeVideo) {
          filteredVideos.push({
            id: video.id,
            title: video.snippet.title,
            description: video.snippet.description,
            thumbnailUrl: video.snippet.thumbnails.high.url,
            channelId: video.snippet.channelId,
            channelTitle: video.snippet.channelTitle,
            publishedAt: video.snippet.publishedAt,
            duration: duration,
            durationSeconds: seconds,
            viewCount: video.statistics.viewCount
          });
          
          channelIds.add(video.snippet.channelId);
        }
      } catch (error) {
        console.error(`Error processing video ${video.id}:`, error);
        // Skip this video if there's an error
      }
    });
    
    console.log(`Filtered to ${filteredVideos.length} videos after duration check`);
    
    // If no channels to check, return current filtered videos
    if (channelIds.size === 0) {
      return res.json({
        videos: filteredVideos,
        nextPageToken: searchResponse.data.nextPageToken || null,
        pageInfo: searchResponse.data.pageInfo,
        totalResults: filteredVideos.length,
        message: filteredVideos.length === 0 ? `No videos found in the last ${lastHours} hours` : null
      });
    }
    
    // Get channel details to check subscriber counts
    const channelsResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: {
        part: 'statistics',
        id: Array.from(channelIds).join(','),
        key: YOUTUBE_API_KEY
      }
    });
    
    // Create map of channel subscriber counts
    const channelSubscribers = {};
    channelsResponse.data.items.forEach(channel => {
      channelSubscribers[channel.id] = parseInt(channel.statistics.subscriberCount, 10);
    });
    
    // Final filtering by subscriber count
    const finalVideos = filteredVideos.filter(video => {
      const subscriberCount = channelSubscribers[video.channelId] || 0;
      video.subscriberCount = subscriberCount; // Add subscriber count to video object
      return subscriberCount >= minSubscribers;
    });
    
    console.log(`Final result: ${finalVideos.length} videos after subscriber check`);
    
    // Return results with pagination info
    res.json({
      videos: finalVideos,
      nextPageToken: searchResponse.data.nextPageToken || null,
      pageInfo: searchResponse.data.pageInfo,
      totalResults: finalVideos.length,
      message: finalVideos.length === 0 ? `No videos found in the last ${lastHours} hours with ${minSubscribers}+ subscribers` : null
    });
    
  } catch (error) {
    console.error('Error fetching AI tool videos:', error);
    res.status(500).json({ 
      error: 'Failed to fetch videos',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Helper function to parse YouTube duration format (PT1H2M3S)
 * @param {string} duration - YouTube duration string
 * @returns {number|null} - Duration in seconds or null if parsing failed
 */
function parseDuration(duration) {
  try {
    if (!duration) return null;
    
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) {
      console.error('Duration format not recognized:', duration);
      return null;
    }
    
    const hours = parseInt(match[1] || 0, 10);
    const minutes = parseInt(match[2] || 0, 10);
    const seconds = parseInt(match[3] || 0, 10);
    return hours * 3600 + minutes * 60 + seconds;
  } catch (error) {
    console.error('Error parsing duration:', duration, error);
    return null;
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});