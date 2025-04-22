/**
 * Notes:
 * youtube api doesn't allow for getting watch percentage
 * do 2 days ago so that in case anything weird happens, we still add the video
 * youtube api doesn't allow for getting watch history
 * youtube api doesn't allow for adding to watch later playlist
 */

export async function manageYouTubeSubscriptionsAndPlaylist({ playlistId }: { playlistId: string }): Promise<object> {
    console.log(`manageYouTubeSubscriptionsAndPlaylist starting with playlistId: ${playlistId}`);
    const days: number = 2;
    const pushToPlaylist = true;

    type video = {
        title: string,
        id: string,
        duration?: number,
        error?: {
            message: string,
            retryCount?: number
        },
        alreadyInPlaylist?: boolean
    }
    // Set of existing video IDs
    const inPlaylistVideoIDs = new Set<string>();

    // Fetch all playlist items, handles pagination
    async function fetchAllPlaylistItems(pageToken: string | null = null): Promise<void> {
        console.log(`fetching playlist items, pageToken: ${pageToken}`);
        const playlistParams = new URLSearchParams({
            part: 'snippet,contentDetails',
            playlistId: playlistId,
            maxResults: '50'
        });

        if (pageToken) {
            playlistParams.append('pageToken', pageToken);
        }

        const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?${playlistParams.toString()}`;
        const playlistResponse = await fetchWithZapier(playlistUrl);
        await playlistResponse.throwErrorIfNotOk();

        const playlistData = await playlistResponse.json();
        for (const item of playlistData.items) {
            const id = item.contentDetails.videoId;
            const title = item.snippet.title;
            console.log(`existing: ${id} - ${title}`);
            inPlaylistVideoIDs.add(id);
        }

        if (playlistData.nextPageToken) {
            await fetchAllPlaylistItems(playlistData.nextPageToken);
        } else {
            console.log(`no next page token`);
        }
    }

    const getSubscribedChannels = async () => {
        const params = new URLSearchParams({ part: "snippet", mine: 'true' });
        const subsURL = `https://www.googleapis.com/youtube/v3/subscriptions?${params.toString()}`;

        const response = await fetchWithZapier(subsURL);
        await response.throwErrorIfNotOk();

        const data = await response.json();
        const channels: string[] = data.items.map((item: any) => item.snippet.resourceId.channelId);
        return channels;
    }

    const channels = await getSubscribedChannels();

    await fetchAllPlaylistItems();

    console.log(`finished fetching playlist items. length: ${inPlaylistVideoIDs.size}`);

    const baseUrl = 'https://www.googleapis.com/youtube/v3/videos';

    // Calculate the date threshold
    const now = new Date();
    const timeAgo = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    const timeAgoISO = timeAgo.toISOString();


    // Response type - will be built up as we go
    const outputDict: {
        added: video[],
        alreadyInPlaylist: video[],
        error: video[],
        alreadyWatched: video[],
        shorts: video[]
    } = {
        error: [],
        added: [],
        alreadyInPlaylist: [],
        alreadyWatched: [],
        shorts: []
    }

    const videosToAdd: video[] = [];

    for (const channel of channels) {
        // Fetch videos from the channel
        const searchParams = new URLSearchParams({
            part: 'id',
            maxResults: '50',
            publishedAfter: timeAgoISO,
            channelId: channel,
            type: 'video'
        });
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`;
        const searchResponse = await fetchWithZapier(searchUrl);
        await searchResponse.throwErrorIfNotOk();
        const searchData = await searchResponse.json();

        // Get the video data for the videos
        const videoIds = searchData.items.map((item: any) => item.id.videoId).join(',');
        const videoParams = new URLSearchParams({
            part: 'contentDetails,snippet',
            id: videoIds
        });
        const videoUrl = `${baseUrl}?${videoParams.toString()}`;
        const videoResponse = await fetchWithZapier(videoUrl);
        await videoResponse.throwErrorIfNotOk();
        const videoData = await videoResponse.json();
        if (!videoData || !videoData.items) {
            throw new Error("Failed to fetch video data or items are missing.");
        }

        // Filter the videos by duration and add to the playlist if they're longer than 1 minute
        for (const item of videoData.items) {
            const id = item.id;
            const title = item.snippet?.title || "Unknown Title";
            const duration = item.contentDetails?.duration || '';

            let totalDuration = 0;
            const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
            if (match) {
                totalDuration += match[1] ? parseInt(match[1]) * 3600 : 0;
                totalDuration += match[2] ? parseInt(match[2]) * 60 : 0;
                totalDuration += match[3] ? parseInt(match[3]) : 0;
            }

            if (totalDuration <= 60) {
                console.log(`Skipping ${title} because it's less than 1 minute`);
                outputDict.shorts.push({ title, id, duration: totalDuration });
                continue;
            }

            if (inPlaylistVideoIDs.has(id)) {
                outputDict.alreadyInPlaylist.push({ title, id });
            } else {
                console.log(`Adding ${title} to playlist`);
                videosToAdd.push({ title, id, duration: totalDuration });
            }
        }
    }

    const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet`;


    const addToPlaylist = async (id: string, title: string, playlistId: string, retryCount = 0) => {
        const maxRetries = 6;
        const baseDelay = 2000; // 2 seconds

        try {
            if (!pushToPlaylist) {
                return;
            }

            const requestBody = {
                snippet: {
                    playlistId: playlistId,
                    resourceId: {
                        kind: "youtube#video",
                        videoId: id
                    }
                }
            };

            console.log(`Attempting to add video ${id} (${title}) to playlist`);
            const response = await fetchWithZapier(playlistUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            try {
                const responseText = await response.text();
                // console.log(`Raw response for ${title}: ${responseText}`);

                if (!responseText) {
                    console.log(`Empty response for ${title}`);
                    return; // Success with no content
                }

                const responseJson = JSON.parse(responseText);
                if (response.ok) {
                    console.log(`Successfully added to playlist: ${id} title: ${title}`);
                    return responseJson;
                } else {
                    console.error(`Error adding to playlist: ${id} title: ${title}`, responseJson);
                    throw new Error(`Error adding to playlist. Response: ${id} title: ${title}`, responseJson);
                }
            } catch (error: any) {
                if (error?.cause?.response?.status === 409 && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    console.log(`Retrying after ${delay}ms for: ${title} (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return addToPlaylist(id, title, playlistId, retryCount + 1);
                }
                console.error(`Error parsing response for ${title}:`, error);
                throw error;
            }
        } catch (error) {
            console.error(`Error adding to playlist: ${id} title: ${title}`, error);
            outputDict.error.push({ title, id, error: { message: error.message, retryCount } });
        }
    }

    for (const video of videosToAdd) {
        if (!video.alreadyInPlaylist) {
            await addToPlaylist(video.id, video.title, playlistId);
            outputDict.added.push(video);
        } else {
            if (video.error) {
                outputDict.error.push(video);
            } else {
                outputDict.alreadyInPlaylist.push(video);
            }
        }
    }
    if (outputDict.error.length > 0) {
        throw new Error(`Error adding to playlist. ${JSON.stringify(outputDict.error)}`);
    }
    return { outputDict };
}