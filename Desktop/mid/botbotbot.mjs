import Web3 from 'web3';
import { TwitterApi } from 'twitter-api-v2';
import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

let cachedConversionRate = null;
let lastFetchedTime = 0;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INFURA_PROJECT_ID = 'process.env.INFURA_PROJECT_ID';
const OPENSEA_API_KEY = 'process.env.OPENSEA_API_KEY';
const COINMARKETCAP_API_KEY = 'process.env.COINMARKETCAP_API_KEY';
const DISCORD_WEBHOOK_URL = 'process.env.DISCORD_WEBHOOK_URL';
const web3 = new Web3(new Web3.providers.WebsocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_PROJECT_ID}`));
const client = new TwitterApi({
    appKey: 'process.env.TWITTER_APP_KEY',
    appSecret: 'process.env.TWITTER_APP_SECRET',
    accessToken: 'process.env.TWITTER_ACCESS_TOKEN',
    accessSecret: 'process.env.TWITTER_ACCESS_SECRET'
});
const rwClient = client.readWrite;
const MOONCATS_CONTRACT_ADDRESS = '0xc3f733ca98E0daD0386979Eb96fb1722A1A05E69';
const MOONCATS_CONTRACT_ABI = [
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "address", "name": "from", "type": "address"},
            {"indexed": true, "internalType": "address", "name": "to", "type": "address"},
            {"indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256"}
        ],
        "name": "Transfer",
        "type": "event"
    }
];
const mooncatsContract = new web3.eth.Contract(MOONCATS_CONTRACT_ABI, MOONCATS_CONTRACT_ADDRESS);
const salesQueue = [];
const transferQueue = [];
const TRANSFER_PROCESS_DELAY_MS = 45000;
let rateLimitResetTime = null;

async function getEthToUsdConversionRate() {
    const currentTime = Date.now();
    const oneHour = 3600000;

    if (cachedConversionRate && (currentTime - lastFetchedTime) < oneHour) {
        return cachedConversionRate;
    }

    const url = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
    const params = new URLSearchParams({ 'symbol': 'ETH', 'convert': 'USD' });

    try {
        const response = await fetch(`${url}?${params}`, {
            method: 'GET',
            headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY, 'Accept': 'application/json' }
        });
        if (!response.ok) {
            throw new Error(`API responded with status ${response.status}`);
        }
        const data = await response.json();
        cachedConversionRate = data.data.ETH.quote.USD.price;
        lastFetchedTime = currentTime;
        return cachedConversionRate;
    } catch (error) {
        console.error('Error fetching ETH to USD conversion rate:', error);
        return null;
    }
}

async function getMoonCatNameOrId(tokenId) {
    const response = await fetch(`https://api.mooncat.community/traits/${tokenId}`);
    const data = await response.json();
    const catIdTrait = data.attributes.find(trait => trait.trait_type === 'MoonCat Id');
    const isNamedTrait = data.attributes.find(trait => trait.trait_type === 'isNamed');
    let catName = catIdTrait ? catIdTrait.value : `0x${tokenId.padStart(64, '0')}`;
    if (isNamedTrait && isNamedTrait.value === 'Yes' && data.name) {
        catName = data.name;
    }
    return catName;
}

function formatEthPrice(ethPrice) {
    return parseFloat(ethPrice.toFixed(3));
}

async function uploadMediaWithRetry(imageBuffer, attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            console.log(`Uploading media, buffer size: ${imageBuffer.length} bytes`);
            const mediaId = await rwClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/png' });
            console.log(`Media uploaded successfully on attempt ${attempt}`);
            return mediaId;
        } catch (error) {
            console.error(`Attempt ${attempt}: Failed to upload media - ${error.message}`);
            if (attempt === attempts) {
                console.error('Max upload attempts reached. Aborting operation.');
                return null;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function sendToDiscord(tweetText, imageUrl, tweetUrl) {
    const payload = {
        embeds: [{
            title: "New Sale",
            description: tweetText,
            url: tweetUrl,
            image: {
                url: imageUrl
            },
            color: 5814783
        }]
    };

    try {
        const response = await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (response.ok) {
            console.log('Successfully sent message to Discord.');
        } else {
            const responseBody = await response.text();
            console.error('Failed to send message:', response.status, response.statusText, responseBody);
        }
    } catch (error) {
        console.error('Error sending message to Discord:', error);
    }
}


async function tweetMoonCatSale(tokenId, ethPrice, mediaId, transactionUrl) {
    const ethToUsdRate = await getEthToUsdConversionRate();
    const formattedEthPrice = formatEthPrice(ethPrice);
    const usdPrice = (ethPrice * ethToUsdRate).toFixed(2);
    const moonCatNameOrId = await getMoonCatNameOrId(tokenId);
    let tweetText = `MoonCat #${tokenId}: ${moonCatNameOrId} adopted for ${formattedEthPrice} ETH ($${usdPrice}).\n\nTx: ${transactionUrl}`;

    if (tweetText.length > 280) {
        tweetText = tweetText.substring(0, 277) + '...';
    }

    try {
        const tweet = await rwClient.v2.tweet(tweetText, { media: { media_ids: [mediaId] } });
        console.log("Tweet posted successfully.");
        const tweetUrl = `https://twitter.com/mooncatbot/status/${tweet.data.id}`;
        const imageUrl = `https://api.mooncat.community/regular-image/${tokenId}`;
        await sendToDiscord(tweetText, imageUrl, tweetUrl);
    } catch (error) {
        console.error(`Error posting tweet: ${error.message}`);
        if (error.code === 429) {
            const resetTimeUnix = error.headers['x-rate-limit-reset'];
            rateLimitResetTime = new Date(resetTimeUnix * 1000);
            console.log(`Rate limit hit. Next reset time: ${rateLimitResetTime}`);
        }
    }
}

async function fetchSaleDataFromOpenSea(tokenId, sellerAddress) {
    try {
        await new Promise(resolve => setTimeout(resolve, 10000));
        const openseaAPIUrl = `https://api.opensea.io/api/v2/events/collection/acclimatedmooncats?event_type=sale&limit=50`;
        const headers = {
            'X-API-KEY': OPENSEA_API_KEY,
            'Accept': 'application/json'
        };

        const response = await fetch(openseaAPIUrl, { headers });
        const data = await response.json();

        if (!Array.isArray(data.asset_events)) {
            console.error('Invalid response structure from OpenSea:', data);
            return null;
        }

        const saleEvent = data.asset_events.find(event =>
            event.nft.identifier.toString() === tokenId.toString() &&
            event.seller.toLowerCase() === sellerAddress.toLowerCase()
        );

        if (saleEvent) {
            console.log(`Sale event found for tokenId ${tokenId}`);
            const ethPrice = saleEvent.payment.quantity / (10 ** saleEvent.payment.decimals);
            const transactionUrl = `https://etherscan.io/tx/${saleEvent.transaction}`;
            console.log(`Fetched sale data from OpenSea: ${JSON.stringify(saleEvent)}`);
            return {
                tokenId,
                ethPrice,
                transactionUrl
            };
        } else {
            console.log(`No sale event found for tokenId ${tokenId}`);
        }
        return null;
    } catch (error) {
        console.error('Error fetching sale data from OpenSea:', error);
    }
}

async function processSalesQueue() {
    while (salesQueue.length > 0) {
        console.log(`Processing sales queue. Queue size: ${salesQueue.length}`);
        const { tokenId, sellerAddress } = salesQueue.shift();
        await new Promise(resolve => setTimeout(resolve, 30000));
        const saleData = await fetchSaleDataFromOpenSea(tokenId, sellerAddress);

        if (saleData) {
            console.log(`Processing sale data for tokenId ${tokenId}`);
            const imageResponse = await fetch(`https://api.mooncat.community/regular-image/${tokenId}`);
            const arrayBuffer = await imageResponse.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            const mediaId = await uploadMediaWithRetry(imageBuffer);
            await tweetMoonCatSale(tokenId, saleData.ethPrice, mediaId, saleData.transactionUrl);
        } else {
            console.log(`Transfer of tokenId ${tokenId} dropped from the sales queue: No corresponding sale event on OpenSea.`);
        }
    }
    console.log("Sales queue processing complete.");
}

async function processTransferQueue() {
    while (transferQueue.length > 0) {
        const transfer = transferQueue.shift();
        await new Promise(resolve => setTimeout(resolve, TRANSFER_PROCESS_DELAY_MS));
        const receipt = await fetchTransactionReceipt(transfer.transactionHash);

        if (receipt && receipt.status) {
            salesQueue.push(transfer);
            if (salesQueue.length === 1) {
                processSalesQueue();
            }
        } else {
            console.error('Failed transaction or receipt not available:', transfer.transactionHash);
        }
    }
}

async function fetchTransactionReceipt(transactionHash) {
    try {
        return await web3.eth.getTransactionReceipt(transactionHash);
    } catch (error) {
        console.error('Error fetching transaction receipt:', error);
        return null;
    }
}

console.log("Setting up event listener for MoonCat transfers");
mooncatsContract.events.Transfer({
    fromBlock: 'latest'
}).on('data', (event) => {
    console.log('Transfer event detected:', event);
    transferQueue.push({
        tokenId: event.returnValues.tokenId,
        transactionHash: event.transactionHash,
        sellerAddress: event.returnValues.from.toLowerCase()
    });

    if (transferQueue.length === 1) {
        processTransferQueue();
    }
}).on('error', console.error);

console.log("Event listener for MoonCat transfers set up successfully.");