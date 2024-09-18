import Web3 from 'web3';
import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import path from 'path';
import sharp from 'sharp';
import { InfuraProvider } from 'ethers';
import { AlchemyProvider, AlchemyWebSocketProvider } from '@ethersproject/providers';
import { Contract } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

function createWeb3Provider() {
    const maxRetries = 10;
    let retryCount = 0;
    let reconnecting = false;
    let wsProvider = null;

    const baseReconnectInterval = 1000;
    const maxReconnectInterval = 30000;

    // Exponential backoff with a cap at 30 seconds
    const reconnectDelay = (retries) => Math.min(baseReconnectInterval * (2 ** retries), maxReconnectInterval);

    function setupWebSocketProvider() {
        if (wsProvider && wsProvider.connected) {
            console.log("WebSocket is already connected.");
            return wsProvider;
        }

        wsProvider = new Web3.providers.WebsocketProvider(`wss://mainnet.infura.io/ws/v3/${process.env.SALES_INFURA_PROJECT_ID}`);

        wsProvider.on('connect', () => {
            console.log('WebSocket connection established.');
            retryCount = 0;
            reconnecting = false;
        });

        wsProvider.on('end', (error) => {
            console.error('WebSocket connection ended. Attempting to reconnect...', error);
            reconnectIfNeeded();
        });

        wsProvider.on('error', (error) => {
            console.error('WebSocket connection error:', error);
            reconnectIfNeeded();
        });
        setInterval(() => {
            const healthStatus = wsProvider.readyState === WebSocket.OPEN ? 'open' : 'closed';
            console.log(`WebSocket health check: Connection is ${healthStatus}`);
            if (healthStatus === 'closed') {
                reconnectIfNeeded(); // Attempt reconnection if health check shows closed
            }
        }, 120000); // Check every 2 minutes

        return wsProvider;
        }, 120000);

        return wsProvider;
    }

    function reconnectIfNeeded() {
        if (reconnecting) {
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
            if (wsProvider) {
                wsProvider.disconnect();
            }

            web3.setProvider(setupWebSocketProvider());
        }, delay);
    }

    return setupWebSocketProvider();
}

const web3 = new Web3(createWeb3Provider());

function runSalesBot() {
    let cachedConversionRate = null;
    let lastFetchedTime = 0;

    const INFURA_PROJECT_ID = process.env.SALES_INFURA_PROJECT_ID;
    const ALCHEMY_PROJECT_ID = process.env.SALES_ALCHEMY_PROJECT_ID;
    const OPENSEA_API_KEY = process.env.SALES_OPENSEA_API_KEY;
    const COINMARKETCAP_API_KEY = process.env.SALES_COINMARKETCAP_API_KEY;
    const DISCORD_WEBHOOK_URL = process.env.SALES_DISCORD_WEBHOOK_URL;

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
        }
    ];

    const mooncatsContract = new web3.eth.Contract(MOONCATS_CONTRACT_ABI, MOONCATS_CONTRACT_ADDRESS);
    const oldWrapperContract = new web3.eth.Contract(OLD_WRAPPER_CONTRACT_ABI, OLD_WRAPPER_CONTRACT_ADDRESS);
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
            return fallbackId;
        }
    }

    function formatEthPrice(ethPrice) {
        return parseFloat(ethPrice.toFixed(3));
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
            const openSeaEmoji = '<:logo_opensea:1202605707325743145>';
            const etherScanEmoji = '<:logo_etherscan:1202605702913462322>';
            const blurEmoji = '<:logo_blur:1202605694654615593>';

            const payload = {
                username: 'MoonCatBot',
                avatar_url: 'https://assets.coingecko.com/coins/images/36766/large/mooncats.png?1712283962',
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

            const response = await fetch(DISCORD_WEBHOOK_URL, {
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
            console.log(`Successfully sent MoonCat #${tokenId} announcement to Discord.`);
        } catch (error) {
            console.error('Error sending sale announcement to Discord:', error);
            await new Promise(resolve => setTimeout(resolve, DISCORD_MESSAGE_DELAY_MS));
            throw error;
        }
    }

    async function sendOldWrapperSaleToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl) {
        console.log(`Constructing Chainstation link for rescueIndex: ${rescueIndex}`);
        if (!messageText) {
            console.error('Error: Message text is empty.');
            return;
        }

        try {
            const openSeaEmoji = '<:logo_opensea:1202605707325743145>';
            const etherScanEmoji = '<:logo_etherscan:1202605702913462322>';
            const blurEmoji = '<:logo_blur:1202605694654615593>';
            
            console.log(`Passing rescueIndex: ${rescueIndex} to Chainstation link`);

            const payload = {
                username: 'MoonCatBot (W)',
                avatar_url: 'https://assets.coingecko.com/coins/images/36766/large/mooncats.png?1712283962',
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

            const response = await fetch(DISCORD_WEBHOOK_URL, {
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
            console.log(`Successfully sent Old Wrapper MoonCat #${tokenId} sale announcement to Discord.`);
        } catch (error) {
            console.error('Error sending sale announcement to Discord (Old Wrapper):', error);
            await new Promise(resolve => setTimeout(resolve, DISCORD_MESSAGE_DELAY_MS));
            throw error;
        }
    }

    async function announceMoonCatSale(tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress) {
        console.log(`Announcing MoonCat sale for tokenId: ${tokenId}`);
        const ethToUsdRate = await getEthToUsdConversionRate();
        if (!ethToUsdRate) {
            return;
        }

        const formattedEthPrice = formatEthPrice(ethPrice);
        const usdPrice = (ethPrice * ethToUsdRate).toFixed(2);
        const moonCatData = await getMoonCatNameOrId(tokenId);
        if (!moonCatData) {
            return;
        }

        const moonCatNameOrId = moonCatData.details.name ? moonCatData.details.name : moonCatData.details.catId;
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

        let messageText = `MoonCat #${tokenId}: ${moonCatNameOrId} found a new home with [${displayBuyerAddress}](https://chainstation.mooncatrescue.com/owners/${buyerAddress}) for ${formattedEthPrice} ${currency} ($${usdPrice})`;

        await sendToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
    }

    async function announceOldWrapperSale(realTokenIdHex, tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress) {
        console.log(`Announcing Old Wrapper sale for tokenId: ${tokenId}`);
        const ethToUsdRate = await getEthToUsdConversionRate();
        if (!ethToUsdRate) {
            return;
        }

        const formattedEthPrice = formatEthPrice(ethPrice);
        const usdPrice = (ethPrice * ethToUsdRate).toFixed(2);

        const { imageUrl, name, rescueIndex, isNamed } = await getOldWrapperImageAndDetails(tokenId);
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

        let messageText = `MoonCat #${rescueIndex}: ${displayCatId}; Wrapped as #${tokenId} found a new home with [${displayBuyerAddress}](https://chainstation.mooncatrescue.com/owners/${buyerAddress}) for ${formattedEthPrice} ${currency} ($${usdPrice})`;

        await sendOldWrapperSaleToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
    }

    async function fetchSaleDataFromOpenSea(tokenId, sellerAddress) {
        console.log(`Fetching sale data from OpenSea for tokenId: ${tokenId}`);
        try {
            await new Promise(resolve => setTimeout(resolve, 10000));
            const openseaAPIUrl = `https://api.opensea.io/api/v2/events/collection/acclimatedmooncats?event_type=sale&limit=50`;
            const openseaAPIUrlOldWrapper = `https://api.opensea.io/api/v2/events/collection/wrapped-mooncatsrescue?event_type=sale&limit=50`;
            const headers = {
                'X-API-KEY': OPENSEA_API_KEY,
                'Accept': 'application/json'
            };

            // Fetch for both MoonCat and OldWrapper contracts
            const [moonCatResponse, oldWrapperResponse] = await Promise.all([
                fetch(openseaAPIUrl, { headers }),
                fetch(openseaAPIUrlOldWrapper, { headers })
            ]);

            const moonCatData = await moonCatResponse.json();
            const oldWrapperData = await oldWrapperResponse.json();

            const combinedData = [...moonCatData.asset_events, ...oldWrapperData.asset_events];

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

    async function processSalesQueue() {
        console.log('Processing sales queue...');
        while (salesQueue.length > 0) {
            const sale = salesQueue.shift();
            console.log(`Processing sale for tokenId: ${sale.tokenId}`);
            try {
                const contractAddress = sale.contractAddress.toLowerCase();
                const saleData = await fetchSaleDataFromOpenSea(sale.tokenId, sale.sellerAddress, contractAddress);

                if (saleData) {

                    if (contractAddress === OLD_WRAPPER_CONTRACT_ADDRESS.toLowerCase()) {
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
                            saleData.toAddress
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
    }

    async function processTransferQueue() {
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
                    if (salesQueue.length === 1) {
                        processSalesQueue();
                    }
                } else {
                    console.log(`Invalid transfer detected for tokenId: ${transfer.tokenId}`);
                }
            } catch (error) {
                console.error(`Error processing transfer for tokenId: ${transfer.tokenId}`, error);
            }
        }
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

function runListingBot() {
    let cachedConversionRate = null;
    let lastFetchedTime = 0;
    let lastProcessedTimestamp = 0;
    let firstRun = true;

    const INFURA_PROJECT_ID = process.env.SALES_INFURA_PROJECT_ID;
    const ALCHEMY_PROJECT_ID = process.env.LISTING_ALCHEMY_PROJECT_ID;
    const OPENSEA_API_KEY = process.env.LISTING_OPENSEA_API_KEY;
    const COINMARKETCAP_API_KEY = process.env.LISTING_COINMARKETCAP_API_KEY;
    const DISCORD_WEBHOOK_URL = process.env.LISTING_DISCORD_WEBHOOK_URL;
    const ETHERSCAN_API_KEY = process.env.LISTING_ETHERSCAN_API_KEY;

    const web3 = new Web3(new Web3.providers.WebsocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_PROJECT_ID}`));
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
        return parseFloat(ethPrice.toFixed(3));
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
            const openSeaEmoji = '<:logo_opensea:1202605707325743145>';
            const blurEmoji = '<:logo_blur:1202605694654615593>';

            const marketplaceEmoji = marketplaceName === "OpenSea" ? openSeaEmoji : blurEmoji;
            const ensNameOrAddress = await resolveEnsName(sellerAddress);
            const shortSellerAddress = sellerAddress.substring(0, 6);
            const displaySellerAddress = ensNameOrAddress !== sellerAddress ? ensNameOrAddress : shortSellerAddress;

            const payload = {
                username: 'MoonCatBot',
                avatar_url: 'https://assets.coingecko.com/coins/images/36766/large/mooncats.png?1712283962',
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
            const openSeaEmoji = '<:logo_opensea:1202605707325743145>';
            const blurEmoji = '<:logo_blur:1202605694654615593>';

            const marketplaceEmoji = marketplaceName === "OpenSea" ? openSeaEmoji : blurEmoji;
            const ensNameOrAddress = await resolveEnsName(sellerAddress);
            const shortSellerAddress = sellerAddress.substring(0, 6);
            const displaySellerAddress = ensNameOrAddress !== sellerAddress ? ensNameOrAddress : shortSellerAddress;

            console.log(`Passing rescueIndex: ${rescueIndex} to Chainstation link`);

            const payload = {
                username: 'MoonCatBot (W)',
                avatar_url: 'https://assets.coingecko.com/coins/images/36766/large/mooncats.png?1712283962',
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

        if (isBlacklisted(sellerAddress, tokenId)) {
            console.log(`Seller ${sellerAddress} with tokenId ${tokenId} is blacklisted. Skipping announcement.`);
            return;
        }

        const ethToUsdRate = await getEthToUsdConversionRate();
        if (!ethToUsdRate) {
            return;
        }

        const formattedEthPrice = formatEthPrice(listing.payment.quantity / (10 ** listing.payment.decimals));
        const usdPrice = (formattedEthPrice * ethToUsdRate).toFixed(2);
        const moonCatNameOrId = listing.asset.name;

        const imageUrl = await getMoonCatImageURL(tokenId);

        const marketplaceName = listing.protocol_address ? "OpenSea" : "Blur";
        const listingUrl = marketplaceName === "Blur"
            ? `https://blur.io/asset/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`
            : listing.asset.opensea_url;

        const messageText = `${moonCatNameOrId} has just been listed for ${formattedEthPrice} ETH ($${usdPrice} USD)`;

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

        const formattedEthPrice = formatEthPrice(listing.payment.quantity / (10 ** listing.payment.decimals));
        const usdPrice = (formattedEthPrice * ethToUsdRate).toFixed(2);

        const { imageUrl, name, realTokenIdHex, rescueIndex, isNamed } = await getOldWrapperImageAndDetails(tokenId);
        console.log(`announceOldWrapperSale: Received rescueIndex: ${rescueIndex}`);

        let marketplaceName = "OpenSea";
        let listingUrl = `https://opensea.io/assets/ethereum/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;

        if (!listing.protocol_address || listing.protocol_address.trim() === '') {
            marketplaceName = "Blur";
            listingUrl = `https://blur.io/asset/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;
        }
    
        const displayCatId = isNamed ? name : `0x${realTokenIdHex}`;

        const messageText = `MoonCat #${rescueIndex}: ${displayCatId}; Wrapped as #${tokenId} has just been listed for ${formattedEthPrice} ETH ($${usdPrice} USD)`;

        await sendOldWrapperListingToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName);

        updateBlacklist(sellerAddress, tokenId);
    }

    async function fetchListingsFromOpenSea(initialRun = false) {
        console.log('Fetching listings from OpenSea...');
        try {
            const openseaAPIUrlMoonCats = `https://api.opensea.io/api/v2/events/collection/acclimatedmooncats?event_type=order&order_type=listing&limit=50`;
            const openseaAPIUrlOldWrapper = `https://api.opensea.io/api/v2/events/collection/wrapped-mooncatsrescue?event_type=order&order_type=listing&limit=50`;

            const headers = {
                'X-API-KEY': OPENSEA_API_KEY,
                'Accept': 'application/json'
            };

            const [responseMoonCats, responseOldWrapper] = await Promise.all([
                fetch(openseaAPIUrlMoonCats, { headers }),
                fetch(openseaAPIUrlOldWrapper, { headers })
            ]);

            const dataMoonCats = await responseMoonCats.json();
            const dataOldWrapper = await responseOldWrapper.json();

            const currentTime = Date.now();
            let listings = [];

            if (initialRun) {
                const ONE_HOUR_MS = 3600000;

                const moonCatsListings = dataMoonCats.asset_events.filter(event => {
                    const eventTime = event.event_timestamp * 1000;
                    const isListing = event.order_type === 'listing' && !event.taker;
                    return (currentTime - eventTime) <= ONE_HOUR_MS && isListing;
                }).slice(0, 20);

                const oldWrapperListings = dataOldWrapper.asset_events.filter(event => {
                    const eventTime = event.event_timestamp * 1000;
                    const isListing = event.order_type === 'listing' && !event.taker;
                    return (currentTime - eventTime) <= ONE_HOUR_MS && isListing;
                }).slice(0, 20);

                listings = [...moonCatsListings, ...oldWrapperListings];

                if (listings.length > 0) {
                    lastProcessedTimestamp = Math.max(...listings.map(event => event.event_timestamp));
                } else {
                    lastProcessedTimestamp = Math.max(
                        Math.max(...dataMoonCats.asset_events.map(event => event.event_timestamp)),
                        Math.max(...dataOldWrapper.asset_events.map(event => event.event_timestamp))
                    );
                }
            } else {
                const moonCatsListings = dataMoonCats.asset_events.filter(event => {
                    const isListing = event.order_type === 'listing' && !event.taker;
                    return event.event_timestamp > lastProcessedTimestamp && isListing;
                });

                const oldWrapperListings = dataOldWrapper.asset_events.filter(event => {
                    const isListing = event.order_type === 'listing' && !event.taker;
                    return event.event_timestamp > lastProcessedTimestamp && isListing;
                });

                listings = [...moonCatsListings, ...oldWrapperListings];

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

                if (listingContract === OLD_WRAPPER_CONTRACT_ADDRESS.toLowerCase()) {
                    await announceOldWrapperListing(listing);
                } else if (listingContract === MOONCATS_CONTRACT_ADDRESS.toLowerCase()) {
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

runSalesBot();
runListingBot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bot is running on port ${PORT}`);
});
