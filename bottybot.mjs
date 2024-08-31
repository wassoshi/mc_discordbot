import { InfuraProvider, Contract } from 'ethers';
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

const provider = new InfuraProvider('homestead', INFURA_PROJECT_ID);

const app = express();
app.use(express.json());

const MOONCATS_CONTRACT_ADDRESS = '0xc3f733ca98e0dad0386979eb96fb1722a1a05e69';
const OLD_WRAPPER_CONTRACT_ADDRESS = '0x7C40c393DC0f283F318791d746d894DdD3693572';

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

const mooncatsContract = new Contract(MOONCATS_CONTRACT_ADDRESS, MOONCATS_CONTRACT_ABI, provider);
const oldWrapperContract = new Contract(OLD_WRAPPER_CONTRACT_ADDRESS, OLD_WRAPPER_CONTRACT_ABI, provider);

const salesQueue = [];
const transferQueue = [];
const TRANSFER_PROCESS_DELAY_MS = 45000;
const DISCORD_MESSAGE_DELAY_MS = 1000;

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
        const response = await fetch(`https://api.opensea.io/api/v1/asset/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`, {
            method: 'GET',
            headers: { 'X-API-KEY': OPENSEA_API_KEY }
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch details for token ${tokenId} from OpenSea: ${response.statusText}`);
        }
        const data = await response.json();
        return {
            imageUrl: data.image_url,
            name: data.name || `Wrapped MoonCat #${tokenId}`
        };
    } catch (error) {
        console.error('Error fetching details from OpenSea:', error);
        return null;
    }
}

async function getEthToUsdConversionRate() {
    const currentTime = Date.now();
    const oneHour = 3600000;

    if (cachedConversionRate && (currentTime - lastFetchedTime) < oneHour) {
        console.log('Using cached ETH to USD conversion rate:', cachedConversionRate);
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
        console.log('Fetched new ETH to USD conversion rate:', cachedConversionRate);
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
        const ensName = await provider.lookupAddress(address);
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
            avatar_url: 'https://x.com/mooncatbot/photo',
            embeds: [{
                title: `MoonCat Adopted`,
                url: marketplaceUrl,
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

async function announceMoonCatSale(tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress) {
    console.log(`Processing sale for MoonCat #${tokenId}...`);

    const ethToUsdRate = await getEthToUsdConversionRate();
    if (!ethToUsdRate) {
        console.log(`Skipping sale for MoonCat #${tokenId} due to missing ETH to USD conversion rate.`);
        return;
    }

    const formattedEthPrice = formatEthPrice(ethPrice);
    const usdPrice = (ethPrice * ethToUsdRate).toFixed(2);
    const moonCatData = await getMoonCatNameOrId(tokenId);
    if (!moonCatData) {
        console.log(`Skipping sale for MoonCat #${tokenId} due to missing MoonCat data.`);
        return;
    }

    const moonCatNameOrId = moonCatData.details.name ? moonCatData.details.name : moonCatData.details.catId;
    const imageUrl = await getMoonCatImageURL(tokenId);
    if (!imageUrl) {
        console.log(`Skipping sale for MoonCat #${tokenId} due to missing image URL.`);
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

    let messageText = `MoonCat #${tokenId}: ${moonCatNameOrId} found a new home with [${displayBuyerAddress}](https://etherscan.io/address/${buyerAddress}) for ${formattedEthPrice} ${currency} ($${usdPrice})`;

    await sendToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
}

async function announceOldWrapperSale(tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress) {
    console.log(`Processing sale for Wrapped MoonCat #${tokenId}...`);

    const ethToUsdRate = await getEthToUsdConversionRate();
    if (!ethToUsdRate) {
        console.log(`Skipping sale for Wrapped MoonCat #${tokenId} due to missing ETH to USD conversion rate.`);
        return;
    }

    const formattedEthPrice = formatEthPrice(ethPrice);
    const usdPrice = (ethPrice * ethToUsdRate).toFixed(2);
    const { imageUrl, name } = await getOldWrapperImageAndDetails(tokenId);
    if (!imageUrl) {
        console.log(`Skipping sale for Wrapped MoonCat #${tokenId} due to missing image URL.`);
        return;
    }

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

    let messageText = `${name} found a new home with [${displayBuyerAddress}](https://etherscan.io/address/${buyerAddress}) for ${formattedEthPrice} ${currency} ($${usdPrice})`;

    await sendToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
}

async function fetchSaleDataFromOpenSea(tokenId, sellerAddress, contractAddress) {
    console.log(`Fetching sale data for MoonCat #${tokenId}...`);
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
            console.log(`No sale events found for MoonCat #${tokenId}`);
            return null;
        }

        const saleEvent = data.asset_events.find(event =>
            event.nft &&
            event.nft.identifier.toString() === tokenId.toString() &&
            event.seller && event.seller.toLowerCase() === sellerAddress.toLowerCase() &&
            event.buyer
        );

        if (!saleEvent) {
            console.log(`No matching sale event found for MoonCat #${tokenId}`);
            return null;
        }

        if (!saleEvent.seller || !saleEvent.buyer || !saleEvent.payment || !saleEvent.transaction) {
            console.log(`Incomplete sale event data for MoonCat #${tokenId}`);
            return null;
        }

        const paymentToken = saleEvent.payment;
        const ethPrice = paymentToken.quantity / (10 ** paymentToken.decimals);
        const transactionUrl = `https://etherscan.io/tx/${saleEvent.transaction}`;
        console.log(`Successfully fetched sale data for MoonCat #${tokenId}`);
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
        console.error(`Error fetching sale data from OpenSea for MoonCat #${tokenId}:`, error);
        return null;
    }
}

async function processSalesQueue() {
    while (salesQueue.length > 0) {
        const sale = salesQueue.shift();
        try {
            let saleData;
            if (sale.contractAddress === OLD_WRAPPER_CONTRACT_ADDRESS) {
                saleData = await fetchSaleDataFromOpenSea(sale.tokenId, sale.sellerAddress, OLD_WRAPPER_CONTRACT_ADDRESS);
            } else {
                saleData = await fetchSaleDataFromOpenSea(sale.tokenId, sale.sellerAddress, MOONCATS_CONTRACT_ADDRESS);
            }

            if (saleData) {
                if (sale.contractAddress === OLD_WRAPPER_CONTRACT_ADDRESS) {
                    await announceOldWrapperSale(
                        saleData.tokenId,
                        saleData.ethPrice,
                        saleData.transactionUrl,
                        saleData.payment,
                        saleData.protocolAddress,
                        saleData.toAddress
                    );
                } else {
                    await announceMoonCatSale(
                        saleData.tokenId,
                        saleData.ethPrice,
                        saleData.transactionUrl,
                        saleData.payment,
                        saleData.protocolAddress,
                        saleData.toAddress
                    );
                }
                await new Promise(resolve => setTimeout(resolve, DISCORD_MESSAGE_DELAY_MS));
            }
        } catch (error) {
            console.error(`Error processing sale for MoonCat #${sale.tokenId}:`, error);
        }
    }
}

async function processTransferQueue() {
    while (transferQueue.length > 0) {
        const transfer = transferQueue.shift();
        console.log(`Processing transfer for MoonCat #${transfer.tokenId}...`);
        try {
            await new Promise(resolve => setTimeout(resolve, TRANSFER_PROCESS_DELAY_MS));
            if (!transfer.transactionHash) {
                console.error(`Missing transaction hash for transfer of MoonCat #${transfer.tokenId}. Skipping.`);
                continue; // Skip this transfer if transactionHash is missing
            }
            const receipt = await fetchTransactionReceipt(transfer.transactionHash);
            if (receipt && receipt.status) {
                salesQueue.push(transfer);
                console.log(`Transfer for MoonCat #${transfer.tokenId} confirmed, added to sales queue.`);
                if (salesQueue.length === 1) {
                    processSalesQueue();
                }
            } else {
                console.log(`Transfer for MoonCat #${transfer.tokenId} not yet confirmed.`);
            }
        } catch (error) {
            console.error(`Error processing transfer for MoonCat #${transfer.tokenId}:`, error);
        }
    }
}

async function fetchTransactionReceipt(transactionHash) {
    try {
        return await provider.getTransactionReceipt(transactionHash);
    } catch (error) {
        console.error(`Error fetching transaction receipt for hash ${transactionHash}:`, error);
        return null;
    }
}

mooncatsContract.on('Transfer', (from, to, tokenId, event) => {
    console.log(`Detected transfer event for MoonCat #${tokenId} from ${from} to ${to}`);
    transferQueue.push({
        tokenId: tokenId.toString(),
        transactionHash: event.transactionHash,
        sellerAddress: from.toLowerCase()
    });
    if (transferQueue.length === 1) {
        processTransferQueue();
    }
});

oldWrapperContract.on('Transfer', (from, to, tokenId, event) => {
    console.log(`Detected transfer event for Wrapped MoonCat #${tokenId} from ${from} to ${to}`);
    transferQueue.push({
        tokenId: tokenId.toString(),
        transactionHash: event.transactionHash,
        sellerAddress: from.toLowerCase()
    });
    if (transferQueue.length === 1) {
        processTransferQueue();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Sales bot listening on port ${PORT}`);
});
