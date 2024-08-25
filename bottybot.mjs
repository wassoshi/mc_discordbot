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
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

const web3 = new Web3(new Web3.providers.WebsocketProvider(`wss://mainnet.infura.io/ws/v3/${INFURA_PROJECT_ID}`));
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

const mooncatsContract = new web3.eth.Contract(MOONCATS_CONTRACT_ABI, MOONCATS_CONTRACT_ADDRESS);
const oldWrapperContract = new web3.eth.Contract(OLD_WRAPPER_CONTRACT_ABI, OLD_WRAPPER_CONTRACT_ADDRESS);

const salesQueue = [];
const transferQueue = [];
const TRANSFER_PROCESS_DELAY_MS = 45000;
const DISCORD_MESSAGE_DELAY_MS = 1000;

async function fetchEnsNameFromWeb3(address) {
    try {
        const ensName = await web3.eth.ens.getName(address);
        if (ensName && ensName.name) {
            return ensName.name;
        }
    } catch (error) {}
    return address;
}

async function resolveEnsName(address) {
    const ensName = await fetchEnsNameFromWeb3(address);
    return ensName || address;
}

async function fetchSaleDataFromOpenSea(tokenId, sellerAddress, contractAddress) {
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
            fromAddress: saleEvent.seller.toLowerCase(),
            toAddress: saleEvent.buyer.toLowerCase(),
            protocolAddress: saleEvent.protocol_address,
            saleSellerAddress: sellerAddress.toLowerCase()
        };
    } catch (error) {
        return null;
    }
}

async function processSalesQueue() {
    while (salesQueue.length > 0) {
        const sale = salesQueue.shift();
        try {
            let saleData;
            if (sale.contractAddress.toLowerCase() === OLD_WRAPPER_CONTRACT_ADDRESS.toLowerCase()) {
                saleData = await fetchSaleDataFromOpenSea(sale.tokenId, sale.sellerAddress, OLD_WRAPPER_CONTRACT_ADDRESS);
            } else {
                saleData = await fetchSaleDataFromOpenSea(sale.tokenId, sale.sellerAddress, MOONCATS_CONTRACT_ADDRESS);
            }

            if (saleData) {
                if (sale.contractAddress.toLowerCase() === OLD_WRAPPER_CONTRACT_ADDRESS.toLowerCase()) {
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
        } catch (error) {}
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
        } catch (error) {}
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
}).on('error', (error) => {});

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
}).on('error', (error) => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {});
