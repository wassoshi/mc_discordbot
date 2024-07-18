import Web3 from 'web3';
import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import path from 'path';
import sharp from 'sharp';

let cachedConversionRate = null;
let lastFetchedTime = 0;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INFURA_PROJECT_ID = process.env.INFURA_PROJECT_ID;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const web3 = new Web3(new Web3.providers.WebsocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_PROJECT_ID}`));
const app = express();

app.use(express.json());

const MOONCATS_CONTRACT_ADDRESS = '0xc3f733ca98e0dad0386979eb96fb1722a1a05e69';
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
const mooncatsContract = new web3.eth.Contract(MOONCATS_CONTRACT_ABI, MOONCATS_CONTRACT_ADDRESS);
const salesQueue = [];
const transferQueue = [];
const TRANSFER_PROCESS_DELAY_MS = 45000;
const IMAGE_CONTRACT_ABI = [
    {
        "inputs": [
            { "internalType": "uint256", "name": "rescueOrder", "type": "uint256" },
            { "internalType": "bool", "name": "glow", "type": "bool" }
        ],
        "name": "imageOf",
        "outputs": [{ "internalType": "string", "name": "", "type": "string" }],
        "stateMutability": "view",
        "type": "function"
    }
];

async function getMoonCatImageURL(tokenId) {
    try {
        const response = await fetch(`https://api.mooncat.community/regular-image/${tokenId}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch MoonCat image: ${response.statusText}`);
        }
        const imageUrl = response.url; // direct url
        return imageUrl;
    } catch (error) {
        console.error('Error fetching MoonCat image URL:', error);
        return null;
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

    console.log(`Fetching data for tokenId: ${tokenIdHex}`);

    try {
        const response = await fetch(`https://api.mooncat.community/traits/${tokenIdHex}`);
        const data = await response.json();

        console.log(`Data received for tokenId ${tokenIdHex}:`, data);

        return data;
    } catch (error) {
        console.error(`Error fetching MoonCat name or ID for token ${tokenIdHex}:`, error);

        const fallbackId = `0x${tokenIdHex.toLowerCase().padStart(64, '0')}`;
        console.log(`Falling back to padded tokenIdHex: ${fallbackId}`);

        return fallbackId;
    }
}

function formatEthPrice(ethPrice) {
    return parseFloat(ethPrice.toFixed(3));
}

async function sendToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl) {
    console.log("sendToDiscord called", { tokenId });

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
            avatar_url: 'https://x.com/mooncatbot/photo',
            embeds: [{
                title: `MoonCat #${tokenId} Adopted`,
                url: marketplaceUrl,
                description: messageText,
                fields: [
                    { name: 'Marketplace', value: `${marketplaceName === "OpenSea" ? openSeaEmoji : blurEmoji} [${marketplaceName}](${marketplaceUrl})`, inline: true },
                    { name: 'Block Explorer', value: `${etherScanEmoji} [Etherscan](${transactionUrl})`, inline: true }
                ],
                color: 3447003,
                image: {
                    url: imageUrl // image
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

        console.log("Sale announcement sent successfully.");
    } catch (error) {
        console.error('Error sending sale announcement to Discord:', error);
    }
}

async function announceMoonCatSale(tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress) {
    const ethToUsdRate = await getEthToUsdConversionRate();
    if (!ethToUsdRate) {
        console.error('Error: Failed to fetch ETH to USD conversion rate.');
        return;
    }

    const formattedEthPrice = formatEthPrice(ethPrice);
    const usdPrice = (ethPrice * ethToUsdRate).toFixed(2);
    const moonCatData = await getMoonCatNameOrId(tokenId);
    if (!moonCatData) {
        console.error('Error: Failed to fetch MoonCat data.');
        return;
    }

    const moonCatNameOrId = moonCatData.details.name ? moonCatData.details.name : moonCatData.details.catId;
    const imageUrl = await getMoonCatImageURL(tokenId);
    if (!imageUrl) {
        console.error('Error: Failed to fetch MoonCat image URL.');
        return;
    }

    const currency = paymentToken.symbol; // symbol
    let marketplaceName = "OpenSea";
    let marketplaceUrl = `https://opensea.io/assets/ethereum/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`;

    if (!protocolAddress || protocolAddress.trim() === '') {
        marketplaceName = "Blur";
        marketplaceUrl = `https://blur.io/asset/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`;
    }

    let messageText = `MoonCat #${tokenId}: ${moonCatNameOrId} found a new home with [this address](https://etherscan.io/address/${buyerAddress}) for ${formattedEthPrice} ${currency} ($${usdPrice})`;
    console.log("Message text:", messageText);

    console.log("Calling sendToDiscord from announceMoonCatSale", { tokenId });
    await sendToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
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
            console.error('Invalid response structure from OpenSea:', data);
            return null;
        }

        const saleEvent = data.asset_events.find(event =>
            event.nft &&
            event.nft.identifier.toString() === tokenId.toString() &&
            event.seller && event.seller.toLowerCase() === sellerAddress.toLowerCase() &&
            event.buyer
        );

        if (!saleEvent) {
            console.log(`No sale event found for tokenId ${tokenId} with seller ${sellerAddress}`);
            return null;
        }

        if (!saleEvent.seller || !saleEvent.buyer || !saleEvent.payment || !saleEvent.transaction) {
            console.error('Sale event is missing required data:', saleEvent);
            return null;
        }

        const paymentToken = saleEvent.payment;
        const ethPrice = paymentToken.quantity / (10 ** paymentToken.decimals);
        const transactionUrl = `https://etherscan.io/tx/${saleEvent.transaction}`;
        console.log(`Fetched sale data from OpenSea: ${JSON.stringify(saleEvent)}`);
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
        console.error('Error fetching sale data from OpenSea:', error);
        return null;
    }
}

async function processSalesQueue() {
    console.log("Started processing sales queue.");
    while (salesQueue.length > 0) {
        console.log(`Processing sales queue. Queue size: ${salesQueue.length}`);
        const sale = salesQueue.shift();
        console.log(`Sale Data: ${JSON.stringify(sale)}`);
        try {
            const saleData = await fetchSaleDataFromOpenSea(sale.tokenId, sale.sellerAddress);
            console.log(`Sale Data from OpenSea: ${JSON.stringify(saleData)}`);
            if (saleData) {
                console.log("Sale Data being passed to announceMoonCatSale:", saleData);
                console.log("Calling announceMoonCatSale from processSalesQueue", { saleData });
                await announceMoonCatSale(
                    saleData.tokenId,
                    saleData.ethPrice,
                    saleData.transactionUrl,
                    saleData.payment,
                    saleData.protocolAddress,
                    saleData.toAddress  // Passing buyer address here
                );
            } else {
                console.log(`No sale event found for tokenId ${sale.tokenId}. Skipping announcement.`);
            }
        } catch (error) {
            console.error(`Error processing sales queue for tokenId ${sale.tokenId}: ${error}`);
        }
    }
    console.log("Sales queue processing complete.");
}

async function processTransferQueue() {
    console.log("Started processing transfer queue.");
    while (transferQueue.length > 0) {
        console.log(`Processing transfer queue. Queue size: ${transferQueue.length}`);
        const transfer = transferQueue.shift();
        console.log(`Transfer Data: ${JSON.stringify(transfer)}`);
        try {
            await new Promise(resolve => setTimeout(resolve, TRANSFER_PROCESS_DELAY_MS));
            const receipt = await fetchTransactionReceipt(transfer.transactionHash);
            console.log(`Receipt for transactionHash ${transfer.transactionHash}: ${JSON.stringify(receipt)}`);
            if (receipt && receipt.status) {
                console.log(`Adding transfer to sales queue`, { transfer });
                salesQueue.push(transfer);
                console.log(`Transfer added to sales queue: ${JSON.stringify(transfer)}`);
                if (salesQueue.length === 1) {
                    processSalesQueue();
                }
            } else {
                console.error(`Failed transaction or receipt not available for transactionHash ${transfer.transactionHash}`);
            }
        } catch (error) {
            console.error(`Error processing transfer queue for transactionHash ${transfer.transactionHash}: ${error}`);
        }
    }
    console.log("Transfer queue processing complete.");
}

async function fetchTransactionReceipt(transactionHash) {
    try {
        return await web3.eth.getTransactionReceipt(transactionHash);
    } catch (error) {
        console.error('Error fetching transaction receipt:', error);
        return null;
    }
}

mooncatsContract.events.Transfer({
    fromBlock: 'latest'
}).on('data', (event) => {
    console.log(`Transfer event detected: ${JSON.stringify(event)}`);
    transferQueue.push({
        tokenId: event.returnValues.tokenId,
        transactionHash: event.transactionHash,
        sellerAddress: event.returnValues.from.toLowerCase()
    });
    console.log(`Added to transfer queue: ${JSON.stringify(transferQueue[transferQueue.length - 1])}`);
    if (transferQueue.length === 1) {
        console.log("Starting transfer queue processing.");
        processTransferQueue();
    }
}).on('error', (error) => {
    console.error(`Error with MoonCat transfer event listener: ${error}`);
});

console.log("Event listener for MoonCat transfers set up successfully.");

// Start Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
