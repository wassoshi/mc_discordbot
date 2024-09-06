import Web3 from 'web3';
import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import path from 'path';
import sharp from 'sharp';
import { InfuraProvider } from 'ethers';
import { AlchemyProvider, AlchemyWebSocketProvider } from '@ethersproject/providers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

function runSalesBot() {
    let cachedConversionRate = null;
    let lastFetchedTime = 0;

    const INFURA_PROJECT_ID = process.env.SALES_INFURA_PROJECT_ID;
    const ALCHEMY_PROJECT_ID = process.env.SALES_ALCHEMY_PROJECT_ID;
    const OPENSEA_API_KEY = process.env.SALES_OPENSEA_API_KEY;
    const COINMARKETCAP_API_KEY = process.env.SALES_COINMARKETCAP_API_KEY;
    const DISCORD_WEBHOOK_URL = process.env.SALES_DISCORD_WEBHOOK_URL;

    const web3 = new Web3(new Web3.providers.WebsocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_PROJECT_ID}`));
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

    async function getRealTokenIdFromWrapper(tokenId) {
        try {
            const contract = new web3.eth.Contract(OLD_WRAPPER_CONTRACT_ABI, OLD_WRAPPER_CONTRACT_ADDRESS);
            const catId = await contract.methods._tokenIDToCatID(tokenId).call();
            return catId;
        } catch (error) {
            console.error(`Error fetching real token ID for wrapped token ${tokenId}:`, error);
            return null;
        }
    }

    async function getMoonCatImageURL(tokenId) {
        try {
            const response = await fetch(`https://api.mooncat.community/regular-image/${tokenId}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch MoonCat image: ${response.statusText}`);
            }
            const imageUrl = response.url;
            return imageUrl;
        } catch (error) {
            console.error('Error fetching MoonCat image URL:', error);
            return null;
        }
    }

    async function getOldWrapperImageAndDetails(tokenId) {
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

            const imageUrl = `https://api.mooncat.community/regular-image/${rescueIndex}`;
            const name = data.details.name ? data.details.name : `MoonCat #${rescueIndex}`;
            const isNamed = data.details.isNamed === "Yes";

            return {
                imageUrl,
                name,
                rescueIndex,
                realTokenIdHex,
                isNamed
            };
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
        const tokenIdStr = tokenId.toString();
        const tokenIdHex = tokenIdStr.startsWith('0x') ? tokenIdStr.slice(2) : tokenIdStr;

        try {
            const response = await fetch(`https://api.mooncat.community/traits/${tokenIdHex}`);
            const data = await response.json();
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
        try {
            const ensName = await ethersProvider.lookupAddress(address);
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

    async function sendOldWrapperSaleToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl) {
        if (!messageText) {
            console.error('Error: Message text is empty.');
            return;
        }

        try {
            const openSeaEmoji = '<:logo_opensea:1202605707325743145>';
            const etherScanEmoji = '<:logo_etherscan:1202605702913462322>';
            const blurEmoji = '<:logo_blur:1202605694654615593>';

            const payload = {
                username: 'MoonCatBot (Old Wrapper)',
                avatar_url: 'https://assets.coingecko.com/coins/images/36766/large/mooncats.png?1712283962',
                embeds: [{
                    title: 'Adopted (Old Wrapper)',
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

    async function announceOldWrapperSale(tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress) {
        const ethToUsdRate = await getEthToUsdConversionRate();
        if (!ethToUsdRate) {
            return;
        }

        const formattedEthPrice = formatEthPrice(ethPrice);
        const usdPrice = (ethPrice * ethToUsdRate).toFixed(2);

        const { imageUrl, name, rescueIndex, realTokenIdHex, isNamed } = await getOldWrapperImageAndDetails(tokenId);
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

        let messageText = `MoonCat #${rescueIndex}: ${displayCatId} found a new home with [${displayBuyerAddress}](https://chainstation.mooncatrescue.com/owners/${buyerAddress}) for ${formattedEthPrice} ${currency} ($${usdPrice})`;

        await sendOldWrapperSaleToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
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

            if (!data || !Array.isArray(data.asset_events) || data.asset_events.length === 0) {
                return null;
            }

            const saleEvent = data.asset_events.find(event =>
                event.nft &&
                event.nft.identifier.toString() === tokenId.toString() &&
                event.seller && event.seller.toLowerCase() === sellerAddress.toLowerCase() &&
                event.buyer
            );

            if (!saleEvent) {
                return null;
            }

            if (!saleEvent.seller || !saleEvent.buyer || !saleEvent.payment || !saleEvent.transaction) {
                return null;
            }

            const paymentToken = saleEvent.payment;
            const ethPrice = paymentToken.quantity / (10 ** paymentToken.decimals);
            const transactionUrl = `https://etherscan.io/tx/${saleEvent.transaction}`;
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
            return null;
        }
    }

    async function processSalesQueue() {
        while (salesQueue.length > 0) {
            const sale = salesQueue.shift();
            try {
                const saleData = await fetchSaleDataFromOpenSea(sale.tokenId, sale.sellerAddress);
                if (saleData) {
                    await announceMoonCatSale(
                        saleData.tokenId,
                        saleData.ethPrice,
                        saleData.transactionUrl,
                        saleData.payment,
                        saleData.protocolAddress,
                        saleData.toAddress
                    );
                    await new Promise(resolve => setTimeout(resolve, DISCORD_MESSAGE_DELAY_MS));
                }
            } catch (error) {
            }
        }
    }

    async function processTransferQueue() {
        while (transferQueue.length > 0) {
            const transfer = transferQueue.shift();
            try {
                await new Promise(resolve => setTimeout(resolve, TRANSFER_PROCESS_DELAY_MS));
                const receipt = await fetchTransactionReceipt(transfer.transactionHash);
                if (receipt && receipt.status) {
                    salesQueue.push(transfer);
                    if (salesQueue.length === 1) {
                        processSalesQueue();
                    }
                }
            } catch (error) {
            }
        }
    }

    async function fetchTransactionReceipt(transactionHash) {
        try {
            return await web3.eth.getTransactionReceipt(transactionHash);
        } catch (error) {
            return null;
        }
    }

    mooncatsContract.events.Transfer({
        fromBlock: 'latest'
    }).on('data', (event) => {
        transferQueue.push({
            tokenId: event.returnValues.tokenId,
            transactionHash: event.transactionHash,
            sellerAddress: event.returnValues.from.toLowerCase()
        });
        if (transferQueue.length === 1) {
            processTransferQueue();
        }
    }).on('error', (error) => {
    });

    oldWrapperContract.events.Transfer({
        fromBlock: 'latest'
    }).on('data', (event) => {
        transferQueue.push({
            tokenId: event.returnValues.tokenId,
            transactionHash: event.transactionHash,
            sellerAddress: event.returnValues.from.toLowerCase()
        });
        if (transferQueue.length === 1) {
            processTransferQueue();
        }
    }).on('error', (error) => {
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

    const web3 = new Web3(new Web3.providers.WebsocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_PROJECT_ID}`));
    const provider = new AlchemyProvider('homestead', ALCHEMY_PROJECT_ID);

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
        try {
            const ensName = await provider.lookupAddress(address);
            return ensName || address;
        } catch (error) {
            return address;
        }
    }

    async function resolveEnsName(address) {
        const ensName = await fetchEnsName(address);
        return ensName || address;
    }

    async function getMoonCatImageURL(tokenId) {
        try {
            const response = await fetch(`https://api.mooncat.community/regular-image/${tokenId}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch MoonCat image: ${response.statusText}`);
            }
            return response.url;
        } catch (error) {
            return null;
        }
    }

    async function getRealTokenIdFromWrapper(tokenId) {
        try {
            const contract = new web3.eth.Contract(OLD_WRAPPER_CONTRACT_ABI, OLD_WRAPPER_CONTRACT_ADDRESS);
            const catId = await contract.methods._tokenIDToCatID(tokenId).call();
            return catId;
        } catch (error) {
            console.error(`Error fetching real token ID for wrapped token ${tokenId}:`, error);
            return null;
        }
    }

    async function getOldWrapperImageAndDetails(tokenId) {
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

            const imageUrl = `https://api.mooncat.community/regular-image/${rescueIndex}`;
            const name = data.details.name ? data.details.name : `MoonCat #${rescueIndex}`;

            return {
                imageUrl,
                name
            };
        } catch (error) {
            console.error('Error fetching details from MoonCat API:', error);
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
    }

    async function sendToDiscord(tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName) {
        if (!messageText) {
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
        } catch (error) {
            await new Promise(resolve => setTimeout(resolve, LISTING_PROCESS_DELAY_MS));
            throw error;
        }
    }

    async function sendOldWrapperListingToDiscord(tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName) {
        if (!messageText) {
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
                username: 'MoonCatBot (Old Wrapper)',
                avatar_url: 'https://assets.coingecko.com/coins/images/36766/large/mooncats.png?1712283962',
                embeds: [{
                    title: 'Listed (Old Wrapper)',
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
        } catch (error) {
            await new Promise(resolve => setTimeout(resolve, LISTING_PROCESS_DELAY_MS));
            throw error;
        }
    }

    async function announceMoonCatListing(listing) {
        const sellerAddress = listing.maker;
        const tokenId = listing.asset.identifier;

        if (isBlacklisted(sellerAddress, tokenId)) {
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
            return;
        }

        const ethToUsdRate = await getEthToUsdConversionRate();
        if (!ethToUsdRate) {
            return;
        }

        const formattedEthPrice = formatEthPrice(listing.payment.quantity / (10 ** listing.payment.decimals));
        const usdPrice = (formattedEthPrice * ethToUsdRate).toFixed(2);

        const { imageUrl, name } = await getOldWrapperImageAndDetails(tokenId);

        let marketplaceName = "OpenSea";
        let listingUrl = `https://opensea.io/assets/ethereum/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;

        if (!listing.protocol_address || listing.protocol_address.trim() === '') {
            marketplaceName = "Blur";
            listingUrl = `https://blur.io/asset/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;
        }

        const messageText = `${name} has just been listed for ${formattedEthPrice} ETH ($${usdPrice} USD)`;

        await sendOldWrapperListingToDiscord(tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName);

        updateBlacklist(sellerAddress, tokenId);
    }

    async function fetchListingsFromOpenSea(initialRun = false) {
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

            return listings;
        } catch (error) {
            return null;
        }
    }

    async function processListingsQueue() {
        LISTINGS_QUEUE.sort((a, b) => a.event_timestamp - b.event_timestamp);

        while (LISTINGS_QUEUE.length > 0) {
            const listing = LISTINGS_QUEUE.shift();
            const orderHash = listing.order_hash;

            if (PROCESSED_LISTINGS.has(orderHash)) {
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
            }
        }
    }

    async function monitorListings() {
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
