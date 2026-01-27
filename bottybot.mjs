import Web3 from 'web3';
import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import path from 'path';
import { AlchemyProvider, AlchemyWebSocketProvider } from '@ethersproject/providers';
import { ethers, Contract } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
const ENABLE_OLD_WRAPPER = false;
const isBlacklistedName = (s) => typeof s === 'string' && /b[^a-zA-Z0-9]*(?:o|0)[^a-zA-Z0-9]*n[^a-zA-Z0-9]*n[^a-zA-Z0-9]*(?:a|4|@)/i.test(s);
const isBlockedFullName = (s) => {
    if (typeof s !== 'string') return false;
    const lower = s.toLowerCase();
    return (
        isBlacklistedName(s) ||      // regex match (bonna variants)
        lower.includes('bonna') ||   // plain substring
        lower.includes('discord')    // anything mentioning discord
    );
};


function createWeb3Provider() {
    const maxRetries = 10;
    let retryCount = 0;
    let reconnecting = false;
    let wsProvider = null;
    let pingInterval = null;

    const baseReconnectInterval = 1000;
    const maxReconnectInterval = 30000;

    const reconnectDelay = (retries) => {
        const baseReconnectInterval = 1000;
        const maxReconnectInterval = 30000;
        const jitter = Math.random() * 1000;
        return Math.min(baseReconnectInterval * (2 ** retries) + jitter, maxReconnectInterval);
    };

    function setupWebSocketProvider() {
        if (wsProvider && wsProvider.connected) {
            console.log("WebSocket is already connected.");
            return wsProvider;
        }

        wsProvider = new Web3.providers.WebsocketProvider(`wss://eth-mainnet.alchemyapi.io/v2/${process.env.SALES_ALCHEMY_PROJECT_ID}`);

        wsProvider.on('connect', () => {
            console.log('WebSocket connection established.');
            retryCount = 0;
            reconnecting = false;
            startPing();
        });

        wsProvider.on('end', (error) => {
            console.error('WebSocket connection ended. Attempting to reconnect...', error);
            stopPing();
            reconnectIfNeeded();
        });

        wsProvider.on('error', (error) => {
            console.error('WebSocket connection error:', error);
            stopPing();
            reconnectIfNeeded();
        });
        setInterval(() => {
            const isOpen = wsProvider && wsProvider.connected;
            console.log(`WebSocket health check: Connection is ${isOpen ? 'open' : 'closed'}`);
            if (!isOpen) {
                reconnectIfNeeded();
            }
        }, 600000);

        return wsProvider;
    }

    function reconnectIfNeeded() {
        if (reconnecting || (wsProvider && wsProvider.connected)) {
            console.log("Reconnection already in progress, skipping duplicate reconnection.");
            return;
        }

        if (retryCount >= maxRetries) {
            console.error('Max reconnection attempts reached. Please check your connection or API provider.');
            return;
        }

        reconnecting = true;
        retryCount += 1;

        const delay = reconnectDelay(retryCount);
        console.log(`Reconnection attempt #${retryCount} in ${delay / 1000} seconds...`);

        setTimeout(() => {
            console.log(`Attempting to reconnect (attempt #${retryCount})...`);
            try {
                if (wsProvider && wsProvider.connected) {
                    wsProvider.disconnect();
                }
                web3.setProvider(setupWebSocketProvider());
            } catch (error) {
                console.error(`Reconnection attempt failed: ${error.message}`);
                reconnecting = false; // Allow further reconnection attempts
            }
        }, delay);
    }

    function startPing() {
        stopPing();
        pingInterval = setInterval(() => {
            if (wsProvider && wsProvider.connected) {
                console.log('Sending ping to keep WebSocket alive...');
                wsProvider.send('{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}', (err) => {
                    if (err) {
                        console.error("Ping error:", err);
                        reconnectIfNeeded();
                    }
                });
            } else {
                console.log('WebSocket is not connected, attempting reconnection.');
                reconnectIfNeeded();
            }
        }, 600000);
    }

    function stopPing() {
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }
    }

    return setupWebSocketProvider();
}

const web3 = new Web3(createWeb3Provider());

function runSalesBot() {
    let cachedConversionRate = null;
    let lastFetchedTime = 0;

    const ALCHEMY_PROJECT_ID = process.env.SALES_ALCHEMY_PROJECT_ID;
    const OPENSEA_API_KEY = process.env.SALES_OPENSEA_API_KEY;
    const COINMARKETCAP_API_KEY = process.env.SALES_COINMARKETCAP_API_KEY;
    const DISCORD_WEBHOOK_URL = process.env.SALES_DISCORD_WEBHOOK_URL;

    const VAULT_ADDRESSES = [
        '0x67bdcd02705cecf08cb296394db7d6ed00a496f9',
        '0xa8b42c82a628dc43c2c2285205313e5106ea2853',
        '0x98968f0747e0a261532cacc0be296375f5c08398',
        '0xd4fe01ce79c84c68f9307d415b8f392d140c242c'
    ];

    const ethersProvider = new AlchemyProvider('homestead', ALCHEMY_PROJECT_ID);

    const MOONCATS_CONTRACT_ADDRESS = '0xc3f733ca98e0dad0386979eb96fb1722a1a05e69';
    const OLD_WRAPPER_CONTRACT_ADDRESS = '0x7c40c393dc0f283f318791d746d894ddd3693572';

    const MOONCATS_CONTRACT_ABI = [
        {
            "anonymous": false,
            "inputs": [
                { "indexed": true, "internalType": "address", "name": "from", "type": "address" },
                { "indexed": true, "internalType": "address", "name": "to", "type": "address" },
                { "indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256" }
            ],
            "name": "Transfer",
            "type": "event"
        }
    ];

    const OLD_WRAPPER_CONTRACT_ABI = [
        {
            "anonymous": false,
            "inputs": [
                { "indexed": true, "internalType": "address", "name": "from", "type": "address" },
                { "indexed": true, "internalType": "address", "name": "to", "type": "address" },
                { "indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256" }
            ],
            "name": "Transfer",
            "type": "event"
        },
        {
            "inputs": [
                { "internalType": "uint256", "name": "tokenId", "type": "uint256" }
            ],
            "name": "_tokenIDToCatID",
            "outputs": [
                { "internalType": "bytes5", "name": "", "type": "bytes5" }
            ],
            "stateMutability": "view",
            "type": "function"
        }
    ];

    const mooncatsContract = new web3.eth.Contract(MOONCATS_CONTRACT_ABI, MOONCATS_CONTRACT_ADDRESS);
    const oldWrapperContract = ENABLE_OLD_WRAPPER
      ? new web3.eth.Contract(OLD_WRAPPER_CONTRACT_ABI, OLD_WRAPPER_CONTRACT_ADDRESS)
      : null;

    const salesQueue = [];
    const transferQueue = [];
    const TRANSFER_PROCESS_DELAY_MS = 45000;
    const DISCORD_MESSAGE_DELAY_MS = 1000;

    async function getRealTokenIdFromWrapper(tokenId, retries = 3) {
        const provider = new AlchemyProvider('homestead', process.env.SALES_ALCHEMY_PROJECT_ID);
        console.log(`Using Alchemy provider to fetch real token ID for token: ${tokenId} with retries: ${retries}`);
        const contract = new Contract(OLD_WRAPPER_CONTRACT_ADDRESS, OLD_WRAPPER_CONTRACT_ABI, provider); 

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const catId = await contract._tokenIDToCatID(tokenId);
                console.log(`Real token ID: ${catId} for wrapped token: ${tokenId}`);
                return catId;
            } catch (error) {
                console.error(`Attempt ${attempt} - Error fetching real token ID for wrapped token ${tokenId}:`, error);
                if (attempt === retries) {
                    throw new Error(`Failed after ${retries} retries`);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        return null;
    }

    async function getMoonCatImageURL(tokenId) {
        console.log(`Fetching MoonCat image URL for tokenId: ${tokenId}`);
        try {
            const response = await fetch(`https://api.mooncat.community/regular-image/${tokenId}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch MoonCat image: ${response.statusText}`);
            }
            const imageUrl = response.url;
            console.log(`Fetched image URL for tokenId: ${tokenId}: ${imageUrl}`);
            return imageUrl;
        } catch (error) {
            console.error('Error fetching MoonCat image URL:', error);
            return null;
        }
    }

    async function getOldWrapperImageAndDetails(tokenId) {
        console.log(`Fetching details for old wrapped tokenId: ${tokenId}`);
        try {
            const realTokenIdHex = await getRealTokenIdFromWrapper(tokenId);
            if (!realTokenIdHex) {
                throw new Error(`Failed to retrieve real token ID for ${tokenId}`);
            }

            const response = await fetch(`https://api.mooncat.community/traits/${realTokenIdHex}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch MoonCat details for token ${realTokenIdHex}: ${response.statusText}`);
            }
            const data = await response.json();
            const rescueIndex = data.details.rescueIndex;
            const name = data.details.name ? data.details.name : `MoonCat #${rescueIndex}`;
            const isNamed = data.details.isNamed === "Yes";
            const imageUrl = `https://api.mooncat.community/regular-image/${rescueIndex}`;
            console.log(`Fetched details for tokenId: ${tokenId} - Name: ${name}, RescueIndex: ${rescueIndex}, IsNamed: ${isNamed}`);
            return { imageUrl, name, rescueIndex, realTokenIdHex, isNamed };
        } catch (error) {
            console.error('Error fetching details from MoonCat API:', error);
            return {
                imageUrl: `https://assets.coingecko.com/coins/images/36766/large/mooncats.png?1712283962`,
                name: null,
                rescueIndex: null,
                realTokenIdHex: null,
                isNamed: false
            };
        }
    }

    async function getEthToUsdConversionRate() {
        const currentTime = Date.now();
        const oneHour = 3600000;
        if (cachedConversionRate && (currentTime - lastFetchedTime) < oneHour) {
            console.log(`Using cached ETH to USD conversion rate: ${cachedConversionRate}`);
            return cachedConversionRate;
        }

        const url = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
        const params = new URLSearchParams({ 'symbol': 'ETH', 'convert': 'USD' });

        console.log(`Fetching ETH to USD conversion rate...`);
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
            console.log(`Fetched ETH to USD conversion rate: ${cachedConversionRate}`);
            return cachedConversionRate;
        } catch (error) {
            console.error('Error fetching ETH to USD conversion rate:', error);
            return null;
        }
    }

    async function getMoonCatNameOrId(tokenId) {
        console.log(`Fetching MoonCat name or ID for tokenId: ${tokenId}`);
        const tokenIdStr = tokenId.toString();
        const tokenIdHex = tokenIdStr.startsWith('0x') ? tokenIdStr.slice(2) : tokenIdStr;

        try {
            const response = await fetch(`https://api.mooncat.community/traits/${tokenIdHex}`);
            const data = await response.json();
            console.log(`Fetched MoonCat name or ID for tokenId: ${tokenId}:`, data);
            return data;
        } catch (error) {
            console.error(`Error fetching MoonCat name or ID for token ${tokenIdHex}:`, error);
            const fallbackId = `0x${tokenIdHex.toLowerCase().padStart(64, '0')}`;
            return { details: { name: null, catId: fallbackId } };
        }
    }

    async function classifyMoonCat(rescueIndex) {
        console.log(`Classifying MoonCat for rescueIndex: ${rescueIndex}`);
        
        if (rescueIndex < 492) {
            return 'Day 1 Rescue, 2017 Rescue';
        } else if (rescueIndex < 904) {
            return 'Day 2 Rescue, 2017 Rescue';
        } else if (rescueIndex < 1569) {
            return 'Week 1 Rescue, 2017 Rescue';
        } else if (rescueIndex < 3365) {
            return '2017 Rescue';
        } else if (rescueIndex < 5684) {
            return '2018 Rescue';
        } else if (rescueIndex < 5755) {
            return '2019 Rescue';
        } else if (rescueIndex < 5758) {
            return '2020 Rescue';
        } else {
            return '2021 Rescue';
        }
    }

    function formatEthPrice(ethPrice) {
        return Number(ethPrice).toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
    }

    async function fetchEnsName(address) {
        console.log(`Fetching ENS name for address: ${address}`);
        try {
            const ensName = await ethersProvider.lookupAddress(address);
            console.log(`Fetched ENS name for address: ${address}: ${ensName}`);
            return ensName || address;
        } catch (error) {
            console.error(`Failed to fetch ENS name for address ${address}:`, error);
            return address;
        }
    }

    async function resolveEnsName(address) {
        const ensName = await fetchEnsName(address);
        return ensName || address;
    }

    async function sendToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl) {
        console.log(`Preparing to send Discord notification for tokenId: ${tokenId}`);
        if (!messageText) {
            console.error('Error: Message text is empty.');
            return;
        }
    
        try {
            const openSeaEmoji = '<:logo_opensea:1202575710791933982>';
            const blurEmoji = '<:logo_blur:1202577510458728458>';
            const etherScanEmoji = '<:logo_etherscan:1202580047765180498>';
    
            const payload = {
                username: 'mooncatbot',
                avatar_url: 'https://i.imgur.com/ufCAV5t.gif',
                embeds: [{
                    title: 'Adopted',
                    url: `https://chainstation.mooncatrescue.com/mooncats/${tokenId}`,
                    description: messageText,
                    fields: [
                        { name: 'Marketplace', value: `${marketplaceName === "OpenSea" ? openSeaEmoji : blurEmoji} [${marketplaceName}](${marketplaceUrl})`, inline: true },
                        { name: 'Block Explorer', value: `${etherScanEmoji} [Etherscan](${transactionUrl})`, inline: true }
                    ],
                    color: 3447003,
                    image: {
                        url: imageUrl
                    }
                }]
            };

            const webhooks = [
              process.env.SALES_DISCORD_WEBHOOK_URL,
              process.env.SALES_DISCORD_WEBHOOK_URL2
            ].filter(Boolean);

    
            for (const webhookUrl of webhooks) {
                try {
                    const response = await fetch(webhookUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });
                    const responseText = await response.text();
                    console.log(`Discord response status: ${response.status}`);
                    console.log(`Discord response text: ${responseText}`);
    
                    if (!response.ok) {
                        throw new Error(`Error sending to Discord: ${response.statusText}`);
                    }
                    console.log(`successfully sent MoonCat #${tokenId} announcement to Discord.`);
                } catch (error) {
                    console.error('Error sending sale announcement to Discord:', error);
                    await new Promise(resolve => setTimeout(resolve, DISCORD_MESSAGE_DELAY_MS));
                    throw error;
                }
            }
        } catch (error) {
            console.error('Error preparing to send Discord notification:', error);
        }
    }
    

    async function sendOldWrapperSaleToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl) {
        console.log(`Constructing Chainstation link for rescueIndex: ${rescueIndex}`);
        if (!messageText) {
            console.error('Error: Message text is empty.');
            return;
        }

        try {
            const openSeaEmoji = '<:logo_opensea:1202575710791933982>';
            const etherScanEmoji = '<:logo_etherscan:1202580047765180498>';
            const blurEmoji = '<:logo_blur:1202577510458728458>';
            
            console.log(`Passing rescueIndex: ${rescueIndex} to Chainstation link`);

            const payload = {
                username: 'mooncatbot (w)',
                avatar_url: 'https://i.imgur.com/ufCAV5t.gif',
                embeds: [{
                    title: 'Adopted',
                    url: `https://chainstation.mooncatrescue.com/mooncats/${rescueIndex}`,
                    description: messageText,
                    fields: [
                        { name: 'Marketplace', value: `${marketplaceName === "OpenSea" ? openSeaEmoji : blurEmoji} [${marketplaceName}](${marketplaceUrl})`, inline: true },
                        { name: 'Block Explorer', value: `${etherScanEmoji} [Etherscan](${transactionUrl})`, inline: true }
                    ],
                    color: 3447003,
                    image: {
                        url: imageUrl
                    }
                }]
            };

            const webhooks = [process.env.SALES_DISCORD_WEBHOOK_URL, process.env.SALES_DISCORD_WEBHOOK_URL2];

            for (const webhookUrl of webhooks) {
                try {
                    const response = await fetch(webhookUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    });
                    const responseText = await response.text();
                    console.log(`Discord response status for ${webhookUrl}: ${response.status}`);
                    console.log(`Discord response text: ${responseText}`);

                    if (!response.ok) {
                        throw new Error(`Error sending to Discord: ${response.statusText}`);
                    }
                    console.log(`Successfully sent Old Wrapper MoonCat #${tokenId} sale announcement to Discord webhook: ${webhookUrl}`);
                } catch (error) {
                    console.error(`Error sending sale announcement to Discord webhook: ${webhookUrl}`, error);
                    await new Promise(resolve => setTimeout(resolve, DISCORD_MESSAGE_DELAY_MS));
                    throw error;
                }
            }
        } catch (error) {
            console.error('Error preparing to send Discord notification (Old Wrapper):', error);
        }
    }


    async function announceMoonCatSale(tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress, sellerAddress) {
        console.log(`Announcing MoonCat sale for tokenId: ${tokenId}`);
        const ethToUsdRate = await getEthToUsdConversionRate();
        if (!ethToUsdRate) {
            return;
        }

        const formattedEthPrice = formatEthPrice(ethPrice);
        const usdPrice = (ethPrice * ethToUsdRate).toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });

        const moonCatData = await getMoonCatNameOrId(tokenId);
        if (!moonCatData) {
            return;
        }

        const moonCatNameOrId = moonCatData.details.name ? moonCatData.details.name : moonCatData.details.catId;
        if (isBlockedFullName(moonCatNameOrId)) {
            console.log(`Blacklisted name detected ("${moonCatNameOrId}"); skipping sale announcement.`);
            return;
        }

        const imageUrl = await getMoonCatImageURL(tokenId);
        if (!imageUrl) {
            return;
        }

        const currency = paymentToken.symbol;
        let marketplaceName = "OpenSea";
        let marketplaceUrl = `https://opensea.io/assets/ethereum/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`;

        if (!protocolAddress || protocolAddress.trim() === '') {
            marketplaceName = "Blur";
            marketplaceUrl = `https://blur.io/asset/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`;
        }

        const ensNameOrAddress = await resolveEnsName(buyerAddress);
        const shortBuyerAddress = buyerAddress.substring(0, 6);
        const displayBuyerAddress = ensNameOrAddress !== buyerAddress ? ensNameOrAddress : shortBuyerAddress;

        const sellerIsVault = VAULT_ADDRESSES.includes(sellerAddress.toLowerCase());
        const buyerIsVault  = VAULT_ADDRESSES.includes(buyerAddress.toLowerCase());

        const rescueIndex = tokenId;
        const classification = await classifyMoonCat(rescueIndex);

        let messageText;
        if (sellerIsVault) {
            messageText = `MoonCat #${tokenId}: ${moonCatNameOrId} adopted from the vault for ${formattedEthPrice} ${currency} ($${usdPrice})\n\n\[ ${classification} \]`;
        } else if (buyerIsVault) {
            messageText = `MoonCat #${tokenId}: ${moonCatNameOrId} placed in the vault for ${formattedEthPrice} ${currency} ($${usdPrice})\n\n\[ ${classification} \]`;
        } else {
            messageText = `MoonCat #${tokenId}: ${moonCatNameOrId} found a new home with [${displayBuyerAddress}](https://chainstation.mooncatrescue.com/owners/${buyerAddress}) for ${formattedEthPrice} ${currency} ($${usdPrice})\n\n\[ ${classification} \]`;
        }
        await sendToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
    }

    async function announceOldWrapperSale(tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress) {
        console.log(`Announcing Old Wrapper sale for tokenId: ${tokenId}`);
        const ethToUsdRate = await getEthToUsdConversionRate();
        if (!ethToUsdRate) {
            return;
        }

        let formattedEthPrice;
        try {
            formattedEthPrice = Number(ethPrice).toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 2
            });

            if (isNaN(formattedEthPrice)) {
                throw new Error("Invalid ethPrice");
            }
        } catch (error) {
            console.error(`Error parsing ethPrice for tokenId ${tokenId}:`, error);
            formattedEthPrice = "N/A";
        }

        const usdPrice = formattedEthPrice !== "N/A" ? (ethPrice * ethToUsdRate).toFixed(2) : "N/A";

        const { imageUrl, name, rescueIndex, realTokenIdHex, isNamed } = await getOldWrapperImageAndDetails(tokenId);
        if (isNamed && isBlockedFullName(name)) {
            console.log(`Blacklisted name detected ("${name}"); skipping old-wrapper sale announcement.`);
            return;
        }

        console.log(`announceOldWrapperSale: Received rescueIndex: ${rescueIndex}`);
        if (!imageUrl) {
            return;
        }

        const displayCatId = isNamed ? name : `0x${realTokenIdHex}`;

        const currency = paymentToken.symbol;
        let marketplaceName = "OpenSea";
        let marketplaceUrl = `https://opensea.io/assets/ethereum/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;

        if (!protocolAddress || protocolAddress.trim() === '') {
            marketplaceName = "Blur";
            marketplaceUrl = `https://blur.io/asset/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;
        }

        const ensNameOrAddress = await resolveEnsName(buyerAddress);
        const shortBuyerAddress = buyerAddress.substring(0, 6);
        const displayBuyerAddress = ensNameOrAddress !== buyerAddress ? ensNameOrAddress : shortBuyerAddress;

        const classification = await classifyMoonCat(rescueIndex);

        let messageText = `MoonCat #${rescueIndex}: ${displayCatId} wrapped as #${tokenId} found a new home with [${displayBuyerAddress}](https://chainstation.mooncatrescue.com/owners/${buyerAddress}) for ${formattedEthPrice} ${currency} ($${usdPrice})\n\n\[ ${classification} \]`;

        await sendOldWrapperSaleToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
    }

    async function fetchSaleDataFromOpenSea(tokenId, sellerAddress) {
        console.log(`Fetching sale data from OpenSea for tokenId: ${tokenId}`);
        try {
            await new Promise(resolve => setTimeout(resolve, 10000));
            const openseaAPIUrl = `https://api.opensea.io/api/v2/events/collection/acclimatedmooncats?event_type=sale&limit=50`;
            const headers = {
                'X-API-KEY': OPENSEA_API_KEY,
                'Accept': 'application/json'
            };

            const moonCatResponse = await fetch(openseaAPIUrl, { headers });
            const moonCatData = await moonCatResponse.json();

            let combinedData = [...moonCatData.asset_events];

            if (ENABLE_OLD_WRAPPER) {
              const openseaAPIUrlOldWrapper = `https://api.opensea.io/api/v2/events/collection/wrapped-mooncatsrescue?event_type=sale&limit=50`;
              const oldWrapperResponse = await fetch(openseaAPIUrlOldWrapper, { headers });
              const oldWrapperData = await oldWrapperResponse.json();
              combinedData = [...combinedData, ...oldWrapperData.asset_events];
            }

            if (!combinedData || combinedData.length === 0) {
                console.log(`No sale events found on OpenSea for tokenId: ${tokenId}`);
                return null;
            }

            const saleEvent = combinedData.find(event =>
                event.nft &&
                event.nft.identifier.toString() === tokenId.toString() &&
                event.seller && event.seller.toLowerCase() === sellerAddress.toLowerCase() &&
                event.buyer
            );

            if (!saleEvent) {
                console.log(`No matching sale event found for tokenId: ${tokenId}`);
                return null;
            }

            if (!saleEvent.seller || !saleEvent.buyer || !saleEvent.payment || !saleEvent.transaction) {
                console.log(`Incomplete sale data for tokenId: ${tokenId}`);
                return null;
            }

            const paymentToken = saleEvent.payment;
            const ethPrice = paymentToken.quantity / (10 ** paymentToken.decimals);
            const transactionUrl = `https://etherscan.io/tx/${saleEvent.transaction}`;
            console.log(`Fetched sale data for tokenId: ${tokenId}`);
            return {
                tokenId,
                ethPrice,
                transactionUrl,
                payment: paymentToken,
                fromAddress: saleEvent.seller,
                toAddress: saleEvent.buyer,
                protocolAddress: saleEvent.protocol_address,
                saleSellerAddress: sellerAddress
            };
        } catch (error) {
            console.error(`Error fetching sale data from OpenSea for tokenId: ${tokenId}`, error);
            return null;
        }
    }

    let isProcessingSales = false;

    async function processSalesQueue() {
        if (isProcessingSales) {
            console.log('Sales queue processing is already in progress.');
            return;
        }

        isProcessingSales = true;
        console.log('Processing sales queue...');

        while (salesQueue.length > 0) {
            const sale = salesQueue.shift();
            console.log(`Processing sale for tokenId: ${sale.tokenId}`);
            try {
                const contractAddress = sale.contractAddress.toLowerCase();
                const saleData = await fetchSaleDataFromOpenSea(sale.tokenId, sale.sellerAddress, contractAddress);

                if (saleData) {

                    if (contractAddress === OLD_WRAPPER_CONTRACT_ADDRESS.toLowerCase()) {
                        if (!ENABLE_OLD_WRAPPER) {
                            console.log('Skipping old-wrapper sale processing (disabled).');
                            continue;
                        }
                        await announceOldWrapperSale(
                            saleData.tokenId,
                            saleData.ethPrice,
                            saleData.transactionUrl,
                            saleData.payment,
                            saleData.protocolAddress,
                            saleData.toAddress
                        );
                    } else if (contractAddress === MOONCATS_CONTRACT_ADDRESS.toLowerCase()) {
                        await announceMoonCatSale(
                            saleData.tokenId,
                            saleData.ethPrice,
                            saleData.transactionUrl,
                            saleData.payment,
                            saleData.protocolAddress,
                            saleData.toAddress,
                            saleData.fromAddress
                        );                        
                    } else {
                        console.error(`Unrecognized contract address: ${contractAddress}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, DISCORD_MESSAGE_DELAY_MS));
                }
            } catch (error) {
                console.error(`Error processing sale for tokenId: ${sale.tokenId}`, error);
            }
        }
        isProcessingSales = false;
        console.log('Finished processing sales queue.');
    }

    let isProcessingTransfers = false;

    async function processTransferQueue() {
        if (isProcessingTransfers) {
            console.log('Transfer queue processing is already in progress.');
            return;
        }
        isProcessingTransfers = true;
        console.log('Processing transfer queue...');
        while (transferQueue.length > 0) {
            const transfer = transferQueue.shift();
            console.log(`Processing transfer for tokenId: ${transfer.tokenId}`);
            try {
                await new Promise(resolve => setTimeout(resolve, TRANSFER_PROCESS_DELAY_MS));
                const receipt = await fetchTransactionReceipt(transfer.transactionHash);
                if (receipt && receipt.status) {
                    console.log(`Valid transfer detected for tokenId: ${transfer.tokenId}, pushing to sales queue`);
                    salesQueue.push(transfer);
                    if (!isProcessingSales) {
                        processSalesQueue();
                    }
                } else {
                    console.log(`Invalid transfer detected for tokenId: ${transfer.tokenId}`);
                }
            } catch (error) {
                console.error(`Error processing transfer for tokenId: ${transfer.tokenId}`, error);
            }
        }

        isProcessingTransfers = false;
        console.log('Finished processing transfer queue.');

    }

    async function fetchTransactionReceipt(transactionHash) {
        console.log(`Fetching transaction receipt for hash: ${transactionHash}`);
        try {
            const receipt = await web3.eth.getTransactionReceipt(transactionHash);
            console.log(`Fetched transaction receipt for hash: ${transactionHash}`);
            return receipt;
        } catch (error) {
            console.error(`Error fetching transaction receipt for hash: ${transactionHash}`, error);
            return null;
        }
    }

    mooncatsContract.events.Transfer({
        fromBlock: 'latest'
    }).on('data', (event) => {
        console.log(`Transfer event detected for tokenId: ${event.returnValues.tokenId}`);
        transferQueue.push({
            tokenId: event.returnValues.tokenId,
            transactionHash: event.transactionHash,
            sellerAddress: event.returnValues.from.toLowerCase(),
            contractAddress: MOONCATS_CONTRACT_ADDRESS
        });
        if (transferQueue.length === 1) {
            processTransferQueue();
        }
    }).on('error', (error) => {
        console.error('Error in MoonCats transfer event listener:', error);
    });
  
  if (ENABLE_OLD_WRAPPER) {
    oldWrapperContract.events.Transfer({
        fromBlock: 'latest'
    }).on('data', (event) => {
        console.log(`Old Wrapper transfer event detected for tokenId: ${event.returnValues.tokenId}`);
        transferQueue.push({
            tokenId: event.returnValues.tokenId,
            transactionHash: event.transactionHash,
            sellerAddress: event.returnValues.from.toLowerCase(),
            contractAddress: OLD_WRAPPER_CONTRACT_ADDRESS
        });
        if (transferQueue.length === 1) {
            processTransferQueue();
        }
    }).on('error', (error) => {
        console.error('Error in Old Wrapper transfer event listener:', error);
    });

    console.log("Sales bot started.");
}
}

function runListingBot() {
    let cachedConversionRate = null;
    let lastFetchedTime = 0;
    let lastProcessedTimestamp = 0;
    let firstRun = true;

    const ALCHEMY_PROJECT_ID = process.env.LISTING_ALCHEMY_PROJECT_ID;
    const OPENSEA_API_KEY = process.env.LISTING_OPENSEA_API_KEY;
    const COINMARKETCAP_API_KEY = process.env.LISTING_COINMARKETCAP_API_KEY;
    const DISCORD_WEBHOOK_URL = process.env.LISTING_DISCORD_WEBHOOK_URL;
    const ETHERSCAN_API_KEY = process.env.LISTING_ETHERSCAN_API_KEY;

    const provider = new AlchemyProvider('homestead', ALCHEMY_PROJECT_ID);
    const wsProvider = new AlchemyWebSocketProvider('homestead', ALCHEMY_PROJECT_ID);

    const MOONCATS_CONTRACT_ADDRESS = '0xc3f733ca98e0dad0386979eb96fb1722a1a05e69';
    const OLD_WRAPPER_CONTRACT_ADDRESS = '0x7c40c393dc0f283f318791d746d894ddd3693572';

    const MOONCATS_CONTRACT_ABI = [
        {
            "anonymous": false,
            "inputs": [
                { "indexed": true, "internalType": "address", "name": "from", "type": "address" },
                { "indexed": true, "internalType": "address", "name": "to", "type": "address" },
                { "indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256" }
            ],
            "name": "Transfer",
            "type": "event"
        }
    ];

    const OLD_WRAPPER_CONTRACT_ABI = [
        {
            "anonymous": false,
            "inputs": [
                { "indexed": true, "internalType": "address", "name": "from", "type": "address" },
                { "indexed": true, "internalType": "address", "name": "to", "type": "address" },
                { "indexed": true, "internalType": "uint256", "name": "tokenId", "type": "uint256" }
            ],
            "name": "Transfer",
            "type": "event"
        },
        {
            "inputs": [
                { "internalType": "uint256", "name": "tokenId", "type": "uint256" }
            ],
            "name": "_tokenIDToCatID",
            "outputs": [
                { "internalType": "bytes5", "name": "", "type": "bytes5" }
            ],
            "stateMutability": "view",
            "type": "function"
        }
    ];
    const LISTINGS_QUEUE = [];
    const PROCESSED_LISTINGS = new Set();
    const LISTING_PROCESS_DELAY_MS = 30000;

    const BLACKLIST = {};
    const ONE_DAY_MS = 86400000;

    async function fetchEnsName(address) {
        console.log(`Fetching ENS name for address: ${address}`);
        try {
            const ensName = await provider.lookupAddress(address);
            console.log(`Fetched ENS name for address: ${address}: ${ensName}`);
            return ensName || address;
        } catch (error) {
            console.error(`Failed to fetch ENS name for address ${address}:`, error);
            return address;
        }
    }

    async function resolveEnsName(address) {
        const ensName = await fetchEnsName(address);
        return ensName || address;
    }

    async function classifyMoonCat(rescueIndex) {
        console.log(`Classifying MoonCat for rescueIndex: ${rescueIndex}`);
        
        if (rescueIndex < 492) {
            return 'Day 1 Rescue, 2017 Rescue';
        } else if (rescueIndex < 904) {
            return 'Day 2 Rescue, 2017 Rescue';
        } else if (rescueIndex < 1569) {
            return 'Week 1 Rescue, 2017 Rescue';
        } else if (rescueIndex < 3365) {
            return '2017 Rescue';
        } else if (rescueIndex < 5684) {
            return '2018 Rescue';
        } else if (rescueIndex < 5755) {
            return '2019 Rescue';
        } else if (rescueIndex < 5758) {
            return '2020 Rescue';
        } else {
            return '2021 Rescue';
        }
    }

    async function getMoonCatImageURL(tokenId) {
        console.log(`Fetching MoonCat image URL for tokenId: ${tokenId}`);
        try {
            const response = await fetch(`https://api.mooncat.community/regular-image/${tokenId}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch MoonCat image: ${response.statusText}`);
            }
            console.log(`Fetched image URL for tokenId: ${tokenId}`);
            return response.url;
        } catch (error) {
            console.error(`Error fetching MoonCat image URL for tokenId: ${tokenId}`, error);
            return null;
        }
    }

    async function getRealTokenIdFromWrapper(tokenId) {
        const provider = new AlchemyProvider('homestead', process.env.LISTING_ALCHEMY_PROJECT_ID);
        const contract = new Contract(OLD_WRAPPER_CONTRACT_ADDRESS, OLD_WRAPPER_CONTRACT_ABI, provider);
        console.log(`Fetching real token ID for wrapped tokenId: ${tokenId}`);
        try {
            const catId = await contract._tokenIDToCatID(tokenId);
            console.log(`Fetched real token ID for wrapped tokenId: ${tokenId} - CatID: ${catId}`);
            return catId;
        } catch (error) {
            console.error(`Error fetching real token ID for wrapped token ${tokenId}:`, error);
            return null;
        }
    }

    async function getOldWrapperImageAndDetails(tokenId) {
        console.log(`Fetching details for old wrapped tokenId: ${tokenId}`);
        try {
            const realTokenIdHex = await getRealTokenIdFromWrapper(tokenId);
            if (!realTokenIdHex) {
                throw new Error(`Failed to retrieve real token ID for ${tokenId}`);
            }

            const response = await fetch(`https://api.mooncat.community/traits/${realTokenIdHex}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch MoonCat details for token ${realTokenIdHex}: ${response.statusText}`);
            }
            const data = await response.json();
            const rescueIndex = data.details.rescueIndex;
            const name = data.details.name ? data.details.name : `MoonCat #${rescueIndex}`;
            const isNamed = data.details.isNamed === "Yes";
            const imageUrl = `https://api.mooncat.community/regular-image/${rescueIndex}`;
            console.log(`Fetched details for tokenId: ${tokenId} - Name: ${name}, RescueIndex: ${rescueIndex}, IsNamed: ${isNamed}`);
            return { imageUrl, name, rescueIndex, realTokenIdHex, isNamed };
        } catch (error) {
            console.error(`Error fetching details for old wrapped tokenId: ${tokenId}`, error);
            return {
                imageUrl: `https://assets.coingecko.com/coins/images/36766/large/mooncats.png?1712283962`,
                name: `Wrapped MoonCat #${tokenId}`
            };
        }
    }

    async function getEthToUsdConversionRate() {
        const currentTime = Date.now();
        const oneHour = 3600000;
        if (cachedConversionRate && (currentTime - lastFetchedTime) < oneHour) {
            console.log(`Using cached ETH to USD conversion rate: ${cachedConversionRate}`);
            return cachedConversionRate;
        }

        const url = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
        const params = new URLSearchParams({ 'symbol': 'ETH', 'convert': 'USD' });

        console.log(`Fetching ETH to USD conversion rate...`);
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
            console.log(`Fetched ETH to USD conversion rate: ${cachedConversionRate}`);
            return cachedConversionRate;
        } catch (error) {
            console.error('Error fetching ETH to USD conversion rate:', error);
            return null;
        }
    }

    function formatEthPrice(ethPrice) {
        return Number(ethPrice).toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
    }

    function isBlacklisted(sellerAddress, tokenId) {
        const currentTime = Date.now();
        if (
            BLACKLIST[sellerAddress] &&
            BLACKLIST[sellerAddress][tokenId] &&
            (currentTime - BLACKLIST[sellerAddress][tokenId]) < ONE_DAY_MS
        ) {
            console.log(`Seller ${sellerAddress} with tokenId ${tokenId} is blacklisted.`);
            return true;
        }
        return false;
    }

    function updateBlacklist(sellerAddress, tokenId) {
        const currentTime = Date.now();
        if (!BLACKLIST[sellerAddress]) {
            BLACKLIST[sellerAddress] = {};
        }
        BLACKLIST[sellerAddress][tokenId] = currentTime;
        console.log(`Added seller: ${sellerAddress}, tokenId: ${tokenId} to blacklist at ${new Date(currentTime).toISOString()}`);
    }

    async function sendToDiscord(tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName) {
        console.log(`Preparing to send Discord notification for listing tokenId: ${tokenId}`);
        if (!messageText) {
            console.error('Error: Message text is empty.');
            return;
        }

        try {
            const openSeaEmoji = '<:logo_opensea:1202575710791933982>';
            const blurEmoji = '<:logo_blur:1202577510458728458>';

            const marketplaceEmoji = marketplaceName === "OpenSea" ? openSeaEmoji : blurEmoji;
            const ensNameOrAddress = await resolveEnsName(sellerAddress);
            const shortSellerAddress = sellerAddress.substring(0, 6);
            const displaySellerAddress = ensNameOrAddress !== sellerAddress ? ensNameOrAddress : shortSellerAddress;

            const payload = {
                username: 'mooncatbot',
                avatar_url: 'https://i.imgur.com/ufCAV5t.gif',
                embeds: [{
                    title: 'Listed',
                    url: `https://chainstation.mooncatrescue.com/mooncats/${tokenId}`,
                    description: `${messageText}`,
                    fields: [
                        { name: 'Seller', value: `[${displaySellerAddress}](https://chainstation.mooncatrescue.com/owners/${sellerAddress})`, inline: true },
                        { name: 'Marketplace', value: `${marketplaceEmoji} [${marketplaceName}](${listingUrl})`, inline: true }
                    ],
                    color: 3447003,
                    thumbnail: {
                        url: imageUrl
                    }
                }]
            };

            const response = await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Error sending to Discord: ${response.statusText}`);
            }
            console.log(`Successfully sent listing announcement for tokenId: ${tokenId} to Discord.`);
        } catch (error) {
            console.error(`Error sending listing announcement to Discord for tokenId: ${tokenId}`, error);
            await new Promise(resolve => setTimeout(resolve, LISTING_PROCESS_DELAY_MS));
            throw error;
        }
    }

    async function sendOldWrapperListingToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName) {
        console.log(`Constructing Chainstation link for rescueIndex: ${rescueIndex}`);
        if (!messageText) {
            console.error('Error: Message text is empty.');
            return;
        }

        try {
            const openSeaEmoji = '<:logo_opensea:1202575710791933982>';
            const blurEmoji = '<:logo_blur:1202577510458728458>';

            const marketplaceEmoji = marketplaceName === "OpenSea" ? openSeaEmoji : blurEmoji;
            const ensNameOrAddress = await resolveEnsName(sellerAddress);
            const shortSellerAddress = sellerAddress.substring(0, 6);
            const displaySellerAddress = ensNameOrAddress !== sellerAddress ? ensNameOrAddress : shortSellerAddress;

            console.log(`Passing rescueIndex: ${rescueIndex} to Chainstation link`);

            const payload = {
                username: 'mooncatbot (w)',
                avatar_url: 'https://i.imgur.com/ufCAV5t.gif',
                embeds: [{
                    title: 'Listed',
                    url: `https://chainstation.mooncatrescue.com/mooncats/${rescueIndex}`,
                    description: `${messageText}`,
                    fields: [
                        { name: 'Seller', value: `[${displaySellerAddress}](https://chainstation.mooncatrescue.com/owners/${sellerAddress})`, inline: true },
                        { name: 'Marketplace', value: `${marketplaceEmoji} [${marketplaceName}](${listingUrl})`, inline: true }
                    ],
                    color: 3447003,
                    thumbnail: {
                        url: imageUrl
                    }
                }]
            };

            const response = await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Error sending to Discord: ${response.statusText}`);
            }
            console.log(`Successfully sent old wrapper listing announcement for tokenId: ${tokenId} to Discord.`);
        } catch (error) {
            console.error(`Error sending old wrapper listing announcement to Discord for tokenId: ${tokenId}`, error);
            await new Promise(resolve => setTimeout(resolve, LISTING_PROCESS_DELAY_MS));
            throw error;
        }
    }

    async function announceMoonCatListing(listing) {
        const sellerAddress = listing.maker;
        const tokenId = listing.asset.identifier;

        if (isBlockedFullName(listing.asset?.name)) {
            console.log(`Blacklisted name detected ("${listing.asset?.name}"); skipping listing announcement.`);
            return;
        }

        if (isBlacklisted(sellerAddress, tokenId)) {
            console.log(`Seller ${sellerAddress} with tokenId ${tokenId} is blacklisted. Skipping announcement.`);
            return;
        }

        const ethToUsdRate = await getEthToUsdConversionRate();
        if (!ethToUsdRate) {
            return;
        }

        const ethPriceRaw = listing.payment.quantity / (10 ** listing.payment.decimals);
        const formattedEthPrice = formatEthPrice(ethPriceRaw);
        const usdPrice = (ethPriceRaw * ethToUsdRate).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
        const moonCatNameOrId = listing.asset.name;

        const rescueIndex = tokenId;
        const classification = await classifyMoonCat(rescueIndex);

        const imageUrl = await getMoonCatImageURL(tokenId);

        const marketplaceName = listing.protocol_address ? "OpenSea" : "Blur";
        const listingUrl = marketplaceName === "Blur"
            ? `https://blur.io/asset/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`
            : listing.asset.opensea_url;

        const messageText = `${moonCatNameOrId} has just been listed for ${formattedEthPrice} ETH ($${usdPrice} USD)\n\n\[ ${classification} \]`;

        await sendToDiscord(tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName);

        updateBlacklist(sellerAddress, tokenId);
    }

    async function announceOldWrapperListing(listing) {
        const sellerAddress = listing.maker;
        const tokenId = listing.asset.identifier;

        if (isBlacklisted(sellerAddress, tokenId)) {
            console.log(`Seller ${sellerAddress} with tokenId ${tokenId} is blacklisted. Skipping announcement.`);
            return;
        }

        const ethToUsdRate = await getEthToUsdConversionRate();
        if (!ethToUsdRate) {
            return;
        }

        const ethPriceRaw = listing.payment.quantity / (10 ** listing.payment.decimals);
        const formattedEthPrice = formatEthPrice(ethPriceRaw);
        const usdPrice = (ethPriceRaw * ethToUsdRate).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });

        const { imageUrl, name, realTokenIdHex, rescueIndex, isNamed } = await getOldWrapperImageAndDetails(tokenId);
        if (isNamed && isBlockedFullName(name)) {
            console.log(`Blacklisted name detected ("${name}"); skipping old-wrapper listing announcement.`);
            return;
        }

        console.log(`announceOldWrapperSale: Received rescueIndex: ${rescueIndex}`);

        let marketplaceName = "OpenSea";
        let listingUrl = `https://opensea.io/assets/ethereum/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;

        if (!listing.protocol_address || listing.protocol_address.trim() === '') {
            marketplaceName = "Blur";
            listingUrl = `https://blur.io/asset/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;
        }
    
        const displayCatId = isNamed ? name : `0x${realTokenIdHex}`;

        const classification = await classifyMoonCat(rescueIndex);

        const messageText = `MoonCat #${rescueIndex}: ${displayCatId} wrapped as #${tokenId} has just been listed for ${formattedEthPrice} ETH ($${usdPrice} USD)\n\n\[ ${classification} \]`;

        await sendOldWrapperListingToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName);

        updateBlacklist(sellerAddress, tokenId);
    }

    async function fetchListingsFromOpenSea(initialRun = false) {
        const pollId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        console.log(`[LISTINGS] poll start pollId=${pollId} initialRun=${initialRun} lastProcessedTimestamp=${lastProcessedTimestamp}`);
        try {
            const t0 = Date.now();

            const openseaAPIUrlMoonCats = `https://api.opensea.io/api/v2/events/collection/acclimatedmooncats?event_type=listing&limit=50`;
            //const openseaAPIUrlOldWrapper = `https://api.opensea.io/api/v2/events/collection/wrapped-mooncatsrescue?event_type=listing&limit=50`;



            const headers = {
                'X-API-KEY': OPENSEA_API_KEY,
                'Accept': 'application/json'
            };

            const [responseMoonCats, responseOldWrapper] = await Promise.all([
                fetch(openseaAPIUrlMoonCats, { headers }),
                //fetch(openseaAPIUrlOldWrapper, { headers })
            ]);
            console.log(
              `[LISTINGS] http pollId=${pollId} ` +
              `mooncats=${responseMoonCats.status} wrapper=${responseOldWrapper.status} ` +
              `ms=${Date.now() - t0}`
            );

            if (!responseMoonCats.ok) {
              const text = await responseMoonCats.text().catch(() => '');
              console.error(`[LISTINGS] mooncats error pollId=${pollId} body=${text.slice(0, 300)}`);
              return null;
            }

            const dataMoonCats = await responseMoonCats.json();
            //const dataOldWrapper = await responseOldWrapper.json();
            console.log(
              `[LISTINGS] parsed pollId=${pollId} ` +
              `mooncats_events=${dataMoonCats?.asset_events?.length ?? 0} ` +
              `wrapper_events=${dataOldWrapper?.asset_events?.length ?? 0}`
            );


            const currentTime = Date.now();
            let listings = [];
            
            console.log("🐾 MoonCats API raw response:", JSON.stringify(dataMoonCats, null, 2));
            //console.log("📦 OldWrapper API raw response:", JSON.stringify(dataOldWrapper, null, 2));

            if (!dataMoonCats.asset_events) {
                console.error("❌ MoonCats asset_events is undefined");
            //}
            //if (!dataOldWrapper.asset_events) {
                //console.error("❌ OldWrapper asset_events is undefined");
            }


            if (initialRun) {
                const ONE_HOUR_MS = 3600000;

                const moonCatsListings = dataMoonCats.asset_events.filter(event => {
                    const eventTime = event.event_timestamp * 1000;
                    const isListing = event.order_type === 'listing' && !event.taker;
                    return (currentTime - eventTime) <= ONE_HOUR_MS && isListing;
                }).slice(0, 20);

                //const oldWrapperListings = dataOldWrapper.asset_events.filter(event => {
                    //const eventTime = event.event_timestamp * 1000;
                    //const isListing = event.order_type === 'listing' && !event.taker;
                    //return (currentTime - eventTime) <= ONE_HOUR_MS && isListing;
                //}).slice(0, 20);

                listings = [...moonCatsListings];

                if (listings.length > 0) {
                    lastProcessedTimestamp = Math.max(...listings.map(event => event.event_timestamp));
                } else {
                    lastProcessedTimestamp = Math.max(
                        Math.max(...dataMoonCats.asset_events.map(event => event.event_timestamp)),
                        //Math.max(...dataOldWrapper.asset_events.map(event => event.event_timestamp))
                    );
                }
            } else {
                const moonCatsListings = dataMoonCats.asset_events.filter(event => {
                    const isListing = event.order_type === 'listing' && !event.taker;
                    return event.event_timestamp > lastProcessedTimestamp && isListing;
                });

                //const oldWrapperListings = dataOldWrapper.asset_events.filter(event => {
                    //const isListing = event.order_type === 'listing' && !event.taker;
                    //return event.event_timestamp > lastProcessedTimestamp && isListing;
                //});

                listings = [...moonCatsListings];

                if (listings.length > 0) {
                    lastProcessedTimestamp = Math.max(...listings.map(event => event.event_timestamp));
                }
            }

            console.log('Fetched listings from OpenSea.');
            return listings;
        } catch (error) {
            console.error('Error fetching listings from OpenSea:', error);
            return null;
        }
    }

    async function processListingsQueue() {
        console.log('Processing listings queue...');
        LISTINGS_QUEUE.sort((a, b) => a.event_timestamp - b.event_timestamp);

        while (LISTINGS_QUEUE.length > 0) {
            const listing = LISTINGS_QUEUE.shift();
            const orderHash = listing.order_hash;

            if (PROCESSED_LISTINGS.has(orderHash)) {
                console.log(`Listing already processed for orderHash: ${orderHash}`);
                continue;
            }

            try {
                const listingContract = listing.asset.contract.toLowerCase();

                // kill wrapper listings only
                if (listingContract === OLD_WRAPPER_CONTRACT_ADDRESS.toLowerCase()) {
                    console.log(`Skipping OLD WRAPPER listing tokenId: ${listing.asset.identifier} (wrapper listings disabled)`);
                    PROCESSED_LISTINGS.add(listing.order_hash);
                    continue;
                }

                if (listingContract === MOONCATS_CONTRACT_ADDRESS.toLowerCase()) {
                    await announceMoonCatListing(listing);
                }


                PROCESSED_LISTINGS.add(orderHash);

                if (PROCESSED_LISTINGS.size > 40) {
                    const oldestProcessed = PROCESSED_LISTINGS.keys().next().value;
                    PROCESSED_LISTINGS.delete(oldestProcessed);
                }

                await new Promise(resolve => setTimeout(resolve, LISTING_PROCESS_DELAY_MS));
            } catch (error) {
                console.error(`Error processing listing for orderHash: ${orderHash}`, error);
            }
        }
    }

    async function monitorListings() {
        console.log('Monitoring listings...');
        if (firstRun) {
            const listings = await fetchListingsFromOpenSea(true);
            firstRun = false;
            if (listings && listings.length > 0) {
                LISTINGS_QUEUE.push(...listings);
                if (LISTINGS_QUEUE.length === listings.length) {
                    processListingsQueue();
                }
            }
        }

        setInterval(async () => {
            const listings = await fetchListingsFromOpenSea();
            if (listings && listings.length > 0) {
                LISTINGS_QUEUE.push(...listings);
                if (LISTINGS_QUEUE.length === listings.length) {
                    processListingsQueue();
                }
            }
        }, 60000);
    }

    monitorListings();
}

async function runNameBot() {
    const ALCHEMY_PROJECT_ID = process.env.NAMING_ALCHEMY_PROJECT_ID;
    const DISCORD_WEBHOOK_URL = process.env.NAMING_DISCORD_WEBHOOK_URL;

    const nameProvider = new AlchemyProvider('homestead', ALCHEMY_PROJECT_ID);

    const MOONCATS_NAMING_CONTRACT_ADDRESS = '0x60cd862c9C687A9dE49aecdC3A99b74A4fc54aB6';

    const moonCatsNamingAbi = [
        {
            "anonymous": false,
            "inputs": [
                { "indexed": true, "name": "catId", "type": "bytes5" },
                { "indexed": false, "name": "catName", "type": "bytes32" }
            ],
            "name": "CatNamed",
            "type": "event"
        }
    ];

    const moonCatsNamingContract = new web3.eth.Contract(moonCatsNamingAbi, MOONCATS_NAMING_CONTRACT_ADDRESS);
    function formatCatId(catId) {
        return `0x${catId.slice(2, 12)}`;
    }

    async function getMoonCatImageURL(catId) {
        console.log(`Fetching MoonCat image URL for catId: ${catId}`);
        try {
            const response = await fetch(`https://api.mooncat.community/regular-image/${catId}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch MoonCat image: ${response.statusText}`);
            }
            return response.url;
        } catch (error) {
            console.error('Error fetching MoonCat image URL:', error);
            return null;
        }
    }

    async function getRescueIndex(catId) {
        console.log(`Fetching MoonCat rescue index for catId: ${catId}`);
        try {
            const response = await fetch(`https://api.mooncat.community/traits/${catId}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch MoonCat rescue index: ${response.statusText}`);
            }
            const data = await response.json();
            return data.details.rescueIndex;
        } catch (error) {
            console.error('Error fetching rescue index:', error);
            return null;
        }
    }

    async function sendNameToDiscord(catId, name, imageUrl, rescueIndex, transactionHash) {
        console.log(`Sending naming event for catId: ${catId}, name: ${name} to Discord`);

        const etherScanEmoji = '<:logo_etherscan:1202580047765180498>';
        const txUrl          = `https://etherscan.io/tx/${transactionHash}`;
        const payload = {
            username: 'mooncatbot',
            avatar_url: 'https://i.imgur.com/ufCAV5t.gif',
            embeds: [{
                title: 'Named',
                url: `https://chainstation.mooncatrescue.com/mooncats/${rescueIndex}`,
                description: `MoonCat #${rescueIndex}: ${catId} has been named ${name}.`,
                fields: [
                    {

                        name: 'Block Explorer',
                        value: `${etherScanEmoji} [Etherscan](${txUrl})`,
                        inline: true
                    }
                ],
                color: 3447003,
                image: {
                    url: imageUrl
                }
            }]
        };

        try {
            const response = await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Error sending name event to Discord: ${response.statusText}`);
            }
        } catch (error) {
            throw new Error(`Failed to send name event to Discord: ${error}`);
        }
    }

    moonCatsNamingContract.events.CatNamed({}, async (error, event) => {
        if (error) {
            console.error('Error receiving CatNamed event:', error);
            return;
        }
        const { catId, catName } = event.returnValues;
        try {
            const formattedCatId = formatCatId(catId);
            const rawName     = web3.utils.hexToUtf8(catName);
            const decodedName = rawName.replace(/\u0000/g, '').trim();
            
            if (isBlockedFullName(decodedName)) {
                console.log(`Blacklisted name detected ("${decodedName}"); skipping naming announcement.`);
                return;
            }   
            const imageUrl = await getMoonCatImageURL(formattedCatId);
            const rescueIndex = await getRescueIndex(formattedCatId);

            if (rescueIndex) {
                await sendNameToDiscord(formattedCatId, decodedName, imageUrl, rescueIndex, event.transactionHash);
            }
        } catch (error) {
            console.error('Error handling CatNamed event:', error);
        }
    });

    console.log('Name bot is running.');
}


runSalesBot();
runListingBot();
runNameBot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bot is running on port ${PORT}`);
});
