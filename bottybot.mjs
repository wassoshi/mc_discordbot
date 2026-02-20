import Web3 from 'web3';
import express from 'express';
import fetch from 'node-fetch';
import { ethers } from 'ethers';

let OpenSeaStreamClient, EventType, Network, StreamWebSocket;
try {
  const m = await import('@opensea/stream-js');
  OpenSeaStreamClient = m.OpenSeaStreamClient;
  EventType = m.EventType;
  Network = m.Network;
} catch {}
try {
  const ws = await import('ws');
  StreamWebSocket = ws.WebSocket;
} catch {}

const app = express();
app.use(express.json());

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isBlacklistedName = (s) =>
  typeof s === 'string' &&
  /b[^a-zA-Z0-9]*(?:o|0)[^a-zA-Z0-9]*n[^a-zA-Z0-9]*n[^a-zA-Z0-9]*(?:a|4|@)/i.test(s);

const isBlockedFullName = (s) => {
  if (typeof s !== 'string') return false;
  const lower = s.toLowerCase();
  return isBlacklistedName(s) || lower.includes('bonna') || lower.includes('discord');
};

function createWeb3Provider(alchemyProjectId, getWeb3, label = 'ws') {
  const maxRetries = 10;
  let retryCount = 0;
  let reconnecting = false;
  let wsProvider = null;
  let pingInterval = null;
  let healthInterval = null;

  const reconnectDelay = (retries) => {
    const baseReconnectInterval = 1000;
    const maxReconnectInterval = 30000;
    const jitter = Math.random() * 1000;
    return Math.min(baseReconnectInterval * (2 ** retries) + jitter, maxReconnectInterval);
  };

  function stopPing() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }

  function stopHealthCheck() {
    if (healthInterval) {
      clearInterval(healthInterval);
      healthInterval = null;
    }
  }

  function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
      const isOpen = wsProvider && wsProvider.connected;
      if (isOpen) {
        console.log(`[${label}] Sending ping to keep WebSocket alive...`);
        wsProvider.send(
          { jsonrpc: "2.0", method: "net_version", params: [], id: 1 },
          (err) => {
            if (err) {
              console.error(`[${label}] Ping error:`, err);
              reconnectIfNeeded();
            }
          }
        );
      } else {
        console.log(`[${label}] WebSocket is not connected, attempting reconnection.`);
        reconnectIfNeeded();
      }
    }, 600000);
  }

  function setupWebSocketProvider() {
    stopPing();
    stopHealthCheck();

    try {
      wsProvider?.connection?.close();
    } catch (e) {
      console.error(`[${label}] Error closing websocket connection:`, e);
    }

    wsProvider = new Web3.providers.WebsocketProvider(
      `wss://eth-mainnet.g.alchemy.com/v2/${alchemyProjectId}`
    );

    wsProvider.on('connect', () => {
      console.log(`[${label}] WebSocket connection established.`);
      retryCount = 0;
      reconnecting = false;
      startPing();
    });

    wsProvider.on('end', (error) => {
      console.error(`[${label}] WebSocket connection ended. Attempting to reconnect...`, error);
      stopPing();
      reconnectIfNeeded();
    });

    wsProvider.on('error', (error) => {
      console.error(`[${label}] WebSocket connection error:`, error);
      stopPing();
      reconnectIfNeeded();
    });

    healthInterval = setInterval(() => {
      const isOpen = wsProvider && wsProvider.connected;
      console.log(`[${label}] WebSocket health check: Connection is ${isOpen ? 'open' : 'closed'}`);
      if (!isOpen) reconnectIfNeeded();
    }, 600000);

    return wsProvider;
  }

  function reconnectIfNeeded() {
    if (reconnecting || (wsProvider && wsProvider.connected)) {
      console.log(`[${label}] Reconnection already in progress, skipping duplicate reconnection.`);
      return;
    }

    if (retryCount >= maxRetries) {
      console.error(`[${label}] Max reconnection attempts reached. Please check your connection or API provider.`);
      return;
    }

    reconnecting = true;
    retryCount += 1;

    const delay = reconnectDelay(retryCount);
    console.log(`[${label}] Reconnection attempt #${retryCount} in ${Math.round(delay / 1000)} seconds...`);

    setTimeout(() => {
      console.log(`[${label}] Attempting to reconnect (attempt #${retryCount})...`);
      try {
        const w3 = typeof getWeb3 === 'function' ? getWeb3() : null;
        if (!w3) {
          console.error(`[${label}] getWeb3() returned null, cannot setProvider during reconnect.`);
          reconnecting = false;
          return;
        }
        w3.setProvider(setupWebSocketProvider());
      } catch (error) {
        console.error(`[${label}] Reconnection attempt failed: ${error.message}`);
        reconnecting = false;
      }
    }, delay);
  }

  return setupWebSocketProvider();
}

/**
 * ONE shared OpenSea Stream client for both sales and listings
 * This reduces websocket connections from 2 to 1 on your single dyno.
 */
function startUnifiedOpenSeaStream({ token, onStreamError, subscribeFn }) {
  if (!OpenSeaStreamClient || !StreamWebSocket || !token) return null;

  const client = new OpenSeaStreamClient({
    network: Network ? Network.MAINNET : undefined,
    token,
    connectOptions: { transport: StreamWebSocket },
    onError: onStreamError
  });

  if (typeof subscribeFn === 'function') subscribeFn(client);
  return client;
}

function runSalesAndListingUnifiedStream({ salesAttach, listingAttach }) {
  const SALES_OPENSEA_API_KEY = process.env.SALES_OPENSEA_API_KEY;
  const LISTING_OPENSEA_API_KEY = process.env.LISTING_OPENSEA_API_KEY;

  const token = SALES_OPENSEA_API_KEY || LISTING_OPENSEA_API_KEY;

  if (!token) {
    console.error('[stream] No OpenSea API key found (SALES_OPENSEA_API_KEY or LISTING_OPENSEA_API_KEY). Unified stream disabled.');
    return null;
  }

  if (SALES_OPENSEA_API_KEY && LISTING_OPENSEA_API_KEY && SALES_OPENSEA_API_KEY !== LISTING_OPENSEA_API_KEY) {
    console.error('[stream] Warning: SALES_OPENSEA_API_KEY and LISTING_OPENSEA_API_KEY differ. Unified stream can use only one token. Using SALES_OPENSEA_API_KEY.');
  }

  if (!OpenSeaStreamClient || !StreamWebSocket) {
    console.error('[stream] Stream libraries not available. Unified stream disabled.');
    return null;
  }

  const client = startUnifiedOpenSeaStream({
    token,
    onStreamError: (err) => {
      console.error('[stream] Unified stream error:', err);
    },
    subscribeFn: (c) => {
      if (typeof salesAttach === 'function') salesAttach(c);
      if (typeof listingAttach === 'function') listingAttach(c);
    }
  });

  if (client) console.log('[stream] Unified OpenSea Stream started (sales + listings).');
  return client;
}

function runSalesBotStream() {
  let cachedConversionRate = null;
  let lastFetchedTime = 0;

  const ALCHEMY_PROJECT_ID = process.env.SALES_ALCHEMY_PROJECT_ID;
  const OPENSEA_API_KEY = process.env.SALES_OPENSEA_API_KEY;
  const COINMARKETCAP_API_KEY = process.env.SALES_COINMARKETCAP_API_KEY;

  const VAULT_ADDRESSES = [
    '0x67bdcd02705cecf08cb296394db7d6ed00a496f9',
    '0xa8b42c82a628dc43c2c2285205313e5106ea2853',
    '0x98968f0747e0a261532cacc0be296375f5c08398',
    '0xd4fe01ce79c84c68f9307d415b8f392d140c242c'
  ].map((a) => a.toLowerCase());

  const MOONCATS_CONTRACT_ADDRESS = '0xc3f733ca98e0dad0386979eb96fb1722a1a05e69';
  const OLD_WRAPPER_CONTRACT_ADDRESS = '0x7c40c393dc0f283f318791d746d894ddd3693572';

  const OLD_WRAPPER_CONTRACT_ABI = [
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

  const ethersProvider = new ethers.AlchemyProvider('homestead', ALCHEMY_PROJECT_ID);
  const wrapperReadContract = new ethers.Contract(OLD_WRAPPER_CONTRACT_ADDRESS, OLD_WRAPPER_CONTRACT_ABI, ethersProvider);

  const DISCORD_MESSAGE_DELAY_MS = 1000;

  async function getRealTokenIdFromWrapper(tokenId, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const catId = await wrapperReadContract._tokenIDToCatID(tokenId);
        return catId;
      } catch (error) {
        console.error(`Attempt ${attempt} - Error fetching real token ID for wrapped token ${tokenId}:`, error);
        if (attempt === retries) throw new Error(`Failed after ${retries} retries`);
        await sleep(1000);
      }
    }
    return null;
  }

  async function getMoonCatImageURL(tokenId) {
    try {
      const response = await fetch(`https://api.mooncat.community/regular-image/${tokenId}`);
      if (!response.ok) throw new Error(`Failed to fetch MoonCat image: ${response.statusText}`);
      return response.url;
    } catch (error) {
      console.error('Error fetching MoonCat image URL:', error);
      return null;
    }
  }

  async function getOldWrapperImageAndDetails(tokenId) {
    try {
      const realTokenIdHex = await getRealTokenIdFromWrapper(tokenId);
      if (!realTokenIdHex) throw new Error(`Failed to retrieve real token ID for ${tokenId}`);

      const response = await fetch(`https://api.mooncat.community/traits/${realTokenIdHex}`);
      if (!response.ok) throw new Error(`Failed to fetch MoonCat details for token ${realTokenIdHex}: ${response.statusText}`);

      const data = await response.json();
      const rescueIndex = data.details.rescueIndex;
      const name = data.details.name ? data.details.name : `MoonCat #${rescueIndex}`;
      const isNamed = data.details.isNamed === "Yes";
      const imageUrl = `https://api.mooncat.community/regular-image/${rescueIndex}`;
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
      return cachedConversionRate;
    }

    if (!COINMARKETCAP_API_KEY) return null;

    const url = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
    const params = new URLSearchParams({ 'symbol': 'ETH', 'convert': 'USD' });

    try {
      const response = await fetch(`${url}?${params}`, {
        method: 'GET',
        headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY, 'Accept': 'application/json' }
      });
      if (!response.ok) throw new Error(`API responded with status ${response.status}`);
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
      return { details: { name: null, catId: fallbackId } };
    }
  }

  async function classifyMoonCat(rescueIndex) {
    if (rescueIndex < 492) return 'Day 1 Rescue, 2017 Rescue';
    if (rescueIndex < 904) return 'Day 2 Rescue, 2017 Rescue';
    if (rescueIndex < 1569) return 'Week 1 Rescue, 2017 Rescue';
    if (rescueIndex < 3365) return '2017 Rescue';
    if (rescueIndex < 5684) return '2018 Rescue';
    if (rescueIndex < 5755) return '2019 Rescue';
    if (rescueIndex < 5758) return '2020 Rescue';
    return '2021 Rescue';
  }

  function formatEthPrice(ethPrice) {
    return Number(ethPrice).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  async function fetchEnsName(address) {
    try {
      const ensName = await ethersProvider.lookupAddress(address);
      return ensName || address;
    } catch (error) {
      return address;
    }
  }

  async function resolveEnsName(address) {
    const ensName = await fetchEnsName(address);
    return ensName || address;
  }

  async function sendToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl) {
    if (!messageText) return;

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
          image: { url: imageUrl }
        }]
      };

      const webhooks = [
        process.env.SALES_DISCORD_WEBHOOK_URL,
        process.env.SALES_DISCORD_WEBHOOK_URL2
      ].filter(Boolean);

      for (const webhookUrl of webhooks) {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const responseText = await response.text();
        console.log(`Discord response status: ${response.status}`);
        console.log(`Discord response text: ${responseText}`);

        if (!response.ok) throw new Error(`Error sending to Discord: ${response.statusText}`);
        await sleep(DISCORD_MESSAGE_DELAY_MS);
      }
    } catch (error) {
      console.error('Error sending Discord notification:', error);
    }
  }

  async function sendOldWrapperSaleToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl) {
    if (!messageText) return;

    try {
      const openSeaEmoji = '<:logo_opensea:1202575710791933982>';
      const etherScanEmoji = '<:logo_etherscan:1202580047765180498>';
      const blurEmoji = '<:logo_blur:1202577510458728458>';

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
          image: { url: imageUrl }
        }]
      };

      const webhooks = [
        process.env.SALES_DISCORD_WEBHOOK_URL,
        process.env.SALES_DISCORD_WEBHOOK_URL2
      ].filter(Boolean);

      for (const webhookUrl of webhooks) {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const responseText = await response.text();
        console.log(`Discord response status for ${webhookUrl}: ${response.status}`);
        console.log(`Discord response text: ${responseText}`);

        if (!response.ok) throw new Error(`Error sending to Discord: ${response.statusText}`);
        await sleep(DISCORD_MESSAGE_DELAY_MS);
      }
    } catch (error) {
      console.error('Error sending Discord notification (Old Wrapper):', error);
    }
  }

  async function announceMoonCatSale(tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress, sellerAddress) {
    const ethToUsdRate = await getEthToUsdConversionRate();

    const formattedEthPrice = formatEthPrice(ethPrice);
    const usdPrice = ethToUsdRate ? (ethPrice * ethToUsdRate).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : null;

    const moonCatData = await getMoonCatNameOrId(tokenId);
    if (!moonCatData) return;

    const moonCatNameOrId = moonCatData.details?.name ? moonCatData.details.name : moonCatData.details?.catId;
    if (isBlockedFullName(moonCatNameOrId)) {
      console.log(`Blacklisted name detected ("${moonCatNameOrId}"); skipping sale announcement.`);
      return;
    }

    const imageUrl = await getMoonCatImageURL(tokenId);
    if (!imageUrl) return;

    const currency = paymentToken?.symbol || 'ETH';
    let marketplaceName = "OpenSea";
    let marketplaceUrl = `https://opensea.io/assets/ethereum/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`;
    if (!protocolAddress || String(protocolAddress).trim() === '') {
      marketplaceName = "Blur";
      marketplaceUrl = `https://blur.io/asset/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`;
    }

    const ensNameOrAddress = await resolveEnsName(buyerAddress);
    const shortBuyerAddress = buyerAddress.substring(0, 6);
    const displayBuyerAddress = ensNameOrAddress !== buyerAddress ? ensNameOrAddress : shortBuyerAddress;

    const sellerIsVault = sellerAddress ? VAULT_ADDRESSES.includes(String(sellerAddress).toLowerCase()) : false;
    const buyerIsVault = buyerAddress ? VAULT_ADDRESSES.includes(String(buyerAddress).toLowerCase()) : false;

    const rescueIndex = Number(tokenId);
    const classification = await classifyMoonCat(rescueIndex);

    let messageText;
    if (sellerIsVault) {
      messageText = `MoonCat #${tokenId}: ${moonCatNameOrId} redeemed from the vault for ${formattedEthPrice} ${currency}${usdPrice ? ` ($${usdPrice})` : ''}\n\n[ ${classification} ]`;
    } else if (buyerIsVault) {
      messageText = `MoonCat #${tokenId}: ${moonCatNameOrId} deposited into the vault for ${formattedEthPrice} ${currency}${usdPrice ? ` ($${usdPrice})` : ''}\n\n[ ${classification} ]`;
    } else {
      messageText = `MoonCat #${tokenId}: ${moonCatNameOrId} found a new home with [${displayBuyerAddress}](https://chainstation.mooncatrescue.com/owners/${buyerAddress}) for ${formattedEthPrice} ${currency}${usdPrice ? ` ($${usdPrice})` : ''}\n\n[ ${classification} ]`;
    }

    await sendToDiscord(tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
  }

  async function announceOldWrapperSale(tokenId, ethPrice, transactionUrl, paymentToken, protocolAddress, buyerAddress, sellerAddress) {
    const ethToUsdRate = await getEthToUsdConversionRate();

    const formattedEthPrice = formatEthPrice(ethPrice);
    const usdPrice = ethToUsdRate ? (ethPrice * ethToUsdRate).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : null;

    const { imageUrl, name, rescueIndex, realTokenIdHex, isNamed } = await getOldWrapperImageAndDetails(tokenId);
    if (isNamed && isBlockedFullName(name)) {
      console.log(`Blacklisted name detected ("${name}"); skipping old-wrapper sale announcement.`);
      return;
    }

    if (!imageUrl || rescueIndex == null) return;

    const displayCatId = isNamed ? name : realTokenIdHex;
    const currency = paymentToken?.symbol || 'ETH';

    let marketplaceName = "OpenSea";
    let marketplaceUrl = `https://opensea.io/assets/ethereum/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;
    if (!protocolAddress || String(protocolAddress).trim() === '') {
      marketplaceName = "Blur";
      marketplaceUrl = `https://blur.io/asset/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;
    }

    const ensNameOrAddress = await resolveEnsName(buyerAddress);
    const shortBuyerAddress = buyerAddress.substring(0, 6);
    const displayBuyerAddress = ensNameOrAddress !== buyerAddress ? ensNameOrAddress : shortBuyerAddress;

    const classification = await classifyMoonCat(rescueIndex);

    const messageText =
      `MoonCat #${rescueIndex}: ${displayCatId} wrapped as #${tokenId} found a new home with ` +
      `[${displayBuyerAddress}](https://chainstation.mooncatrescue.com/owners/${buyerAddress}) for ` +
      `${formattedEthPrice} ${currency}${usdPrice ? ` ($${usdPrice})` : ''}\n\n[ ${classification} ]`;

    await sendOldWrapperSaleToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, transactionUrl, marketplaceName, marketplaceUrl);
  }

  async function fetchOpenSeaSaleEvents(collectionSlug) {
    if (!OPENSEA_API_KEY) return { events: [], status: 0, body: '' };

    const headers = { 'X-API-KEY': OPENSEA_API_KEY, 'Accept': 'application/json' };
    const url = `https://api.opensea.io/api/v2/events/collection/${collectionSlug}?event_type=sale&limit=50`;

    try {
      const res = await fetch(url, { headers });
      const body = await res.text();
      let data = null;
      try { data = JSON.parse(body); } catch {}
      const events = data?.asset_events || data?.events || [];
      return { events: Array.isArray(events) ? events : [], status: res.status, body: body.slice(0, 800) };
    } catch (e) {
      return { events: [], status: 0, body: String(e?.message || e) };
    }
  }

  async function hydrateSaleByTxHash(collectionSlug, txHash, expectedSellerLower) {
    const tx = String(txHash || '').toLowerCase();
    if (!tx) return null;

    for (let attempt = 1; attempt <= 10; attempt++) {
      const { events, status, body } = await fetchOpenSeaSaleEvents(collectionSlug);

      if (status === 429) {
        const wait = Math.min(30000, 1500 * attempt);
        console.log(`[sales] OpenSea 429 on hydrate. waitMs=${wait} attempt=${attempt}`);
        await sleep(wait);
        continue;
      }

      if (!events || events.length === 0) {
        const wait = Math.min(20000, 1200 * attempt);
        console.log(`[sales] No sale events yet for slug=${collectionSlug} tx=${tx.slice(0, 10)} attempt=${attempt} status=${status} body=${body}`);
        await sleep(wait);
        continue;
      }

      const match = events.find((e) => {
        const etx = String(e?.transaction || '').toLowerCase();
        if (!etx || etx !== tx) return false;
        if (expectedSellerLower) {
          const s = String(e?.seller || '').toLowerCase();
          if (s && s !== expectedSellerLower) return false;
        }
        return true;
      });

      if (!match) {
        const wait = Math.min(20000, 1200 * attempt);
        await sleep(wait);
        continue;
      }

      const nft = match?.nft || {};
      const tokenId = nft?.identifier?.toString();
      const contract = String(nft?.contract || '').toLowerCase();
      const seller = String(match?.seller || '').toLowerCase();
      const buyer = String(match?.buyer || '').toLowerCase();
      const paymentToken = match?.payment || {};
      const protocolAddress = match?.protocol_address || '';
      const ethPrice = Number(paymentToken.quantity) / (10 ** Number(paymentToken.decimals ?? 18));
      const transactionUrl = `https://etherscan.io/tx/${match.transaction}`;

      if (!tokenId || !contract || !seller || !buyer || !paymentToken || !match.transaction) return null;

      return {
        tokenId,
        contractAddress: contract,
        seller,
        buyer,
        payment: paymentToken,
        protocolAddress,
        ethPrice,
        transactionUrl
      };
    }

    return null;
  }

  function normalizeStreamSoldEvent(event, slugHint) {
    try {
      const outer = event?.payload ?? event;
      const payload = outer && outer.payload && outer.event_type ? outer.payload : outer;

      const txHash =
        payload?.transaction?.hash ||
        payload?.transaction_hash ||
        payload?.transactionHash ||
        payload?.transaction ||
        null;

      const maker =
        payload?.maker?.address ||
        payload?.maker?.wallet_address ||
        payload?.maker ||
        null;

      const taker =
        payload?.taker?.address ||
        payload?.taker?.wallet_address ||
        payload?.taker ||
        null;

      const protocolAddress = payload?.protocol_address || payload?.protocolAddress || '';

      const item = payload?.item || {};
      const nftId = item?.nft_id || item?.nftId || payload?.nft_id || payload?.nftId || null;

      let contract = null;
      let tokenId = null;
      if (typeof nftId === 'string' && nftId.length) {
        const parts = nftId.split('/').filter(Boolean);
        if (parts.length >= 3) {
          tokenId = parts[parts.length - 1];
          contract = parts[parts.length - 2];
        }
      }

      const tsStr = payload?.event_timestamp || payload?.eventTimestamp || payload?.transaction?.timestamp || null;
      const tsSec = tsStr ? Math.floor(new Date(tsStr).getTime() / 1000) : Math.floor(Date.now() / 1000);

      return {
        slug: slugHint,
        txHash: txHash ? String(txHash) : null,
        seller: maker ? String(maker).toLowerCase() : null,
        buyer: taker ? String(taker).toLowerCase() : null,
        protocolAddress,
        contractAddress: contract ? String(contract).toLowerCase() : null,
        tokenId: tokenId ? String(tokenId) : null,
        event_timestamp: tsSec
      };
    } catch (e) {
      console.error('Failed to normalize stream sold event:', e);
      return null;
    }
  }

  const SALES_QUEUE = [];
  const PROCESSED_SALES = new Set();
  let isProcessingSales = false;

  async function processSalesQueue() {
    if (isProcessingSales) return;
    isProcessingSales = true;

    while (SALES_QUEUE.length > 0) {
      const sale = SALES_QUEUE.shift();

      try {
        let tokenId = sale.tokenId;
        let contractAddress = sale.contractAddress;
        let seller = sale.seller;
        let buyer = sale.buyer;
        let protocolAddress = sale.protocolAddress;
        let payment = null;
        let ethPrice = null;
        let transactionUrl = null;

        const key = `${sale.slug}:${String(sale.txHash || '')}`;
        if (PROCESSED_SALES.has(key)) continue;

        const hydrated = await hydrateSaleByTxHash(sale.slug, sale.txHash, seller);
        if (!hydrated) {
          console.log(`[sales] Could not hydrate sale for slug=${sale.slug} tx=${String(sale.txHash).slice(0, 12)}...`);
          continue;
        }

        tokenId = hydrated.tokenId;
        contractAddress = hydrated.contractAddress;
        seller = hydrated.seller;
        buyer = hydrated.buyer;
        payment = hydrated.payment;
        ethPrice = hydrated.ethPrice;
        transactionUrl = hydrated.transactionUrl;
        protocolAddress = hydrated.protocolAddress;

        PROCESSED_SALES.add(key);
        if (PROCESSED_SALES.size > 300) {
          const first = PROCESSED_SALES.keys().next().value;
          PROCESSED_SALES.delete(first);
        }

        if (contractAddress === OLD_WRAPPER_CONTRACT_ADDRESS.toLowerCase()) {
          await announceOldWrapperSale(
            tokenId,
            ethPrice,
            transactionUrl,
            payment,
            protocolAddress,
            buyer,
            seller
          );
        } else if (contractAddress === MOONCATS_CONTRACT_ADDRESS.toLowerCase()) {
          await announceMoonCatSale(
            tokenId,
            ethPrice,
            transactionUrl,
            payment,
            protocolAddress,
            buyer,
            seller
          );
        } else {
          console.error(`[sales] Unrecognized contract address: ${contractAddress}`);
        }
      } catch (e) {
        console.error('[sales] Error processing sale:', e);
      }
    }

    isProcessingSales = false;
    if (SALES_QUEUE.length > 0) setImmediate(processSalesQueue);
  }

  /**
   * Attach sales subscriptions onto an existing OpenSea stream client
   */
  function attachSalesToStreamClient(client) {
    if (!client) return;

    const cutoffSec = Math.floor((Date.now() - 3600000) / 1000);

    const handlerFactory = (slug) => (event) => {
      const normalized = normalizeStreamSoldEvent(event, slug);
      if (!normalized?.txHash) return;
      if (normalized.event_timestamp && normalized.event_timestamp < cutoffSec) return;

      const key = `${slug}:${normalized.txHash}`;
      if (PROCESSED_SALES.has(key)) return;

      SALES_QUEUE.push(normalized);
      processSalesQueue();
    };

    client.onItemSold('acclimatedmooncats', handlerFactory('acclimatedmooncats'));
    client.onItemSold('wrapped-mooncatsrescue', handlerFactory('wrapped-mooncatsrescue'));

    console.log('Sales bot attached to Unified OpenSea Stream.');
  }

  // Expose attach fn so we can register on the unified client
  return {
    attachSalesToStreamClient
  };
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

  const provider = new ethers.AlchemyProvider('homestead', ALCHEMY_PROJECT_ID);

  const MOONCATS_CONTRACT_ADDRESS = '0xc3f733ca98e0dad0386979eb96fb1722a1a05e69';
  const OLD_WRAPPER_CONTRACT_ADDRESS = '0x7c40c393dc0f283f318791d746d894ddd3693572';

  const OLD_WRAPPER_CONTRACT_ABI = [
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

  const wrapperReadContract = new ethers.Contract(OLD_WRAPPER_CONTRACT_ADDRESS, OLD_WRAPPER_CONTRACT_ABI, provider);

  const LISTINGS_QUEUE = [];
  const PROCESSED_LISTINGS = new Set();
  const LISTING_PROCESS_DELAY_MS = 30000;

  const BLACKLIST = {};
  const ONE_DAY_MS = 86400000;

  const BASE_POLL_MS = 300000;
  const MAX_BACKOFF_MS = 1800000;
  const BETWEEN_REQUESTS_MS = 1200;

  let nextPollMs = BASE_POLL_MS;
  let consecutive429 = 0;
  let isProcessingListings = false;

  function normalizeStreamListingEvent(event) {
    try {
      const outer = event?.payload ?? event;
      const payload = outer && outer.payload && outer.event_type ? outer.payload : outer;

      const item = payload?.item || {};
      const nftId = item?.nft_id || item?.nftId || payload?.nft_id || payload?.nftId;
      if (typeof nftId !== 'string' || nftId.length === 0) return null;

      const parts = nftId.split('/').filter(Boolean);
      if (parts.length < 3) return null;

      const tokenId = parts[parts.length - 1];
      const contract = parts[parts.length - 2];

      const makerAddress = payload?.maker?.address || payload?.maker?.wallet_address || payload?.maker || null;
      const orderHash = payload?.order_hash || payload?.orderHash || null;

      const tsStr = payload?.event_timestamp || payload?.eventTimestamp || payload?.transaction?.timestamp || null;
      const tsSec = tsStr ? Math.floor(new Date(tsStr).getTime() / 1000) : Math.floor(Date.now() / 1000);

      const paymentToken = payload?.payment_token || payload?.paymentToken || {};
      const price =
        payload?.listing_price ??
        payload?.base_price ??
        payload?.starting_price ??
        payload?.start_price ??
        payload?.price ??
        payload?.current_price ??
        null;

      return {
        event_type: 'listing',
        event_timestamp: tsSec,
        order_hash: orderHash || `stream_${contract}_${tokenId}_${tsSec}`,
        maker: makerAddress,
        taker: null,
        protocol_address: payload?.protocol_address || payload?.protocolAddress || '',
        payment: {
          quantity: price ?? '0',
          decimals: paymentToken.decimals ?? 18,
          symbol: paymentToken.symbol || 'ETH'
        },
        nft: {
          identifier: tokenId,
          contract,
          name: item?.metadata?.name || null,
          opensea_url: item?.permalink || item?.opensea_url || null
        }
      };
    } catch (e) {
      console.error('Failed to normalize stream listing event:', e);
      return null;
    }
  }

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

  async function classifyMoonCat(rescueIndex) {
    if (rescueIndex < 492) return 'Day 1 Rescue, 2017 Rescue';
    if (rescueIndex < 904) return 'Day 2 Rescue, 2017 Rescue';
    if (rescueIndex < 1569) return 'Week 1 Rescue, 2017 Rescue';
    if (rescueIndex < 3365) return '2017 Rescue';
    if (rescueIndex < 5684) return '2018 Rescue';
    if (rescueIndex < 5755) return '2019 Rescue';
    if (rescueIndex < 5758) return '2020 Rescue';
    return '2021 Rescue';
  }

  async function getMoonCatImageURL(tokenId) {
    try {
      const response = await fetch(`https://api.mooncat.community/regular-image/${tokenId}`);
      if (!response.ok) throw new Error(`Failed to fetch MoonCat image: ${response.statusText}`);
      return response.url;
    } catch (error) {
      console.error(`Error fetching MoonCat image URL for tokenId: ${tokenId}`, error);
      return null;
    }
  }

  async function getRealTokenIdFromWrapper(tokenId) {
    try {
      const catId = await wrapperReadContract._tokenIDToCatID(tokenId);
      return catId;
    } catch (error) {
      console.error(`Error fetching real token ID for wrapped token ${tokenId}:`, error);
      return null;
    }
  }

  async function getOldWrapperImageAndDetails(tokenId) {
    try {
      const realTokenIdHex = await getRealTokenIdFromWrapper(tokenId);
      if (!realTokenIdHex) throw new Error(`Failed to retrieve real token ID for ${tokenId}`);

      const response = await fetch(`https://api.mooncat.community/traits/${realTokenIdHex}`);
      if (!response.ok) throw new Error(`Failed to fetch MoonCat details for token ${realTokenIdHex}: ${response.statusText}`);

      const data = await response.json();
      const rescueIndex = data.details.rescueIndex;
      const name = data.details.name ? data.details.name : `MoonCat #${rescueIndex}`;
      const isNamed = data.details.isNamed === "Yes";
      const imageUrl = `https://api.mooncat.community/regular-image/${rescueIndex}`;
      return { imageUrl, name, rescueIndex, realTokenIdHex, isNamed };
    } catch (error) {
      console.error(`Error fetching details for old wrapped tokenId: ${tokenId}`, error);
      return {
        imageUrl: `https://assets.coingecko.com/coins/images/36766/large/mooncats.png?1712283962`,
        name: `Wrapped MoonCat #${tokenId}`,
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

    if (!COINMARKETCAP_API_KEY) return null;

    const url = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
    const params = new URLSearchParams({ 'symbol': 'ETH', 'convert': 'USD' });

    try {
      const response = await fetch(`${url}?${params}`, {
        method: 'GET',
        headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY, 'Accept': 'application/json' }
      });
      if (!response.ok) throw new Error(`API responded with status ${response.status}`);
      const data = await response.json();
      cachedConversionRate = data.data.ETH.quote.USD.price;
      lastFetchedTime = currentTime;
      return cachedConversionRate;
    } catch (error) {
      console.error('Error fetching ETH to USD conversion rate:', error);
      return null;
    }
  }

  function formatEthPrice(ethPrice) {
    return Number(ethPrice).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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
    if (!BLACKLIST[sellerAddress]) BLACKLIST[sellerAddress] = {};
    BLACKLIST[sellerAddress][tokenId] = currentTime;
  }

  async function sendToDiscord(tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName) {
    if (!messageText) return;

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
        thumbnail: { url: imageUrl }
      }]
    };

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Error sending to Discord: ${response.statusText}`);
  }

  async function sendOldWrapperListingToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName) {
    if (!messageText) return;

    const openSeaEmoji = '<:logo_opensea:1202575710791933982>';
    const blurEmoji = '<:logo_blur:1202577510458728458>';
    const marketplaceEmoji = marketplaceName === "OpenSea" ? openSeaEmoji : blurEmoji;

    const ensNameOrAddress = await resolveEnsName(sellerAddress);
    const shortSellerAddress = sellerAddress.substring(0, 6);
    const displaySellerAddress = ensNameOrAddress !== sellerAddress ? ensNameOrAddress : shortSellerAddress;

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
        thumbnail: { url: imageUrl }
      }]
    };

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Error sending to Discord: ${response.statusText}`);
  }

  async function announceMoonCatListing(listing) {
    const sellerAddress = listing.maker;
    const nft = listing.nft || listing.asset;
    const tokenId = nft?.identifier;
    if (!tokenId) return;

    if (isBlockedFullName(nft?.name)) return;

    if (isBlacklisted(sellerAddress, tokenId)) {
      console.log(`Seller ${sellerAddress} with tokenId ${tokenId} is blacklisted. Skipping announcement.`);
      return;
    }

    const ethToUsdRate = await getEthToUsdConversionRate();
    const ethPriceRaw = Number(listing.payment.quantity) / (10 ** Number(listing.payment.decimals ?? 18));
    const formattedEthPrice = formatEthPrice(ethPriceRaw);
    const usdPrice = ethToUsdRate ? (ethPriceRaw * ethToUsdRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;

    const moonCatNameOrId = nft.name || `MoonCat #${tokenId}`;
    const rescueIndex = Number(tokenId);
    const classification = await classifyMoonCat(rescueIndex);
    const imageUrl = await getMoonCatImageURL(tokenId);

    const marketplaceName = listing.protocol_address ? "OpenSea" : "Blur";
    const listingUrl = marketplaceName === "Blur"
      ? `https://blur.io/asset/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`
      : (nft.opensea_url || `https://opensea.io/assets/ethereum/${MOONCATS_CONTRACT_ADDRESS}/${tokenId}`);

    const messageText = `${moonCatNameOrId} has just been listed for ${formattedEthPrice} ETH${usdPrice ? ` ($${usdPrice} USD)` : ''}\n\n[ ${classification} ]`;

    await sendToDiscord(tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName);
    updateBlacklist(sellerAddress, tokenId);
  }

  async function announceOldWrapperListing(listing) {
    const sellerAddress = listing.maker;
    const nft = listing.nft || listing.asset;
    const tokenId = nft?.identifier;
    if (!tokenId) return;

    if (isBlacklisted(sellerAddress, tokenId)) {
      console.log(`Seller ${sellerAddress} with tokenId ${tokenId} is blacklisted. Skipping announcement.`);
      return;
    }

    const ethToUsdRate = await getEthToUsdConversionRate();
    const ethPriceRaw = Number(listing.payment.quantity) / (10 ** Number(listing.payment.decimals ?? 18));
    const formattedEthPrice = formatEthPrice(ethPriceRaw);
    const usdPrice = ethToUsdRate ? (ethPriceRaw * ethToUsdRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;

    const { imageUrl, name, realTokenIdHex, rescueIndex, isNamed } = await getOldWrapperImageAndDetails(tokenId);
    if (isNamed && isBlockedFullName(name)) return;

    if (!imageUrl || rescueIndex == null) return;

    let marketplaceName = "OpenSea";
    let listingUrl = `https://opensea.io/assets/ethereum/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;
    if (!listing.protocol_address || String(listing.protocol_address).trim() === '') {
      marketplaceName = "Blur";
      listingUrl = `https://blur.io/asset/${OLD_WRAPPER_CONTRACT_ADDRESS}/${tokenId}`;
    }

    const displayCatId = isNamed ? name : realTokenIdHex;
    const classification = await classifyMoonCat(rescueIndex);

    const messageText =
      `MoonCat #${rescueIndex}: ${displayCatId} wrapped as #${tokenId} has just been listed for ` +
      `${formattedEthPrice} ETH${usdPrice ? ` ($${usdPrice} USD)` : ''}\n\n[ ${classification} ]`;

    await sendOldWrapperListingToDiscord(realTokenIdHex, rescueIndex, tokenId, messageText, imageUrl, listingUrl, sellerAddress, marketplaceName);
    updateBlacklist(sellerAddress, tokenId);
  }

  async function fetchOpenSeaEvents(url, headers, label) {
    const res = await fetch(url, { headers });
    const text = await res.text();

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (!res.ok) {
      console.error(`[OpenSea:${label}] HTTP ${res.status} ${res.statusText} body=${text.slice(0, 500)}`);
      return { events: [], status: res.status };
    }

    const events = data?.asset_events || data?.events || [];
    if (!Array.isArray(events)) {
      const keys = data ? Object.keys(data).join(",") : "null";
      console.error(`[OpenSea:${label}] Unexpected JSON shape keys=${keys} body=${text.slice(0, 500)}`);
      return { events: [], status: 200 };
    }

    return { events, status: 200 };
  }

  async function fetchListingsFromOpenSea(initialRun = false) {
    try {
      if (!OPENSEA_API_KEY) {
        console.error('[listing] LISTING_OPENSEA_API_KEY is missing. Listing bot disabled.');
        return { listings: [], rateLimited: false };
      }

      const headers = { 'X-API-KEY': OPENSEA_API_KEY, 'Accept': 'application/json' };

      const openseaAPIUrlMoonCats = `https://api.opensea.io/api/v2/events/collection/acclimatedmooncats?event_type=listing&limit=50`;
      const openseaAPIUrlOldWrapper = `https://api.opensea.io/api/v2/events/collection/wrapped-mooncatsrescue?event_type=listing&limit=50`;

      const moonResp = await fetchOpenSeaEvents(openseaAPIUrlMoonCats, headers, 'acclimatedmooncats listing');
      await sleep(BETWEEN_REQUESTS_MS);
      const wrapResp = await fetchOpenSeaEvents(openseaAPIUrlOldWrapper, headers, 'wrapped-mooncatsrescue listing');

      const moonEvents = moonResp.events || [];
      const wrapEvents = wrapResp.events || [];

      const rateLimited = moonResp.status === 429 || wrapResp.status === 429;

      const currentTime = Date.now();
      let listings = [];

      const isListingEvent = (e) => (e?.event_type === 'listing' || e?.order_type === 'listing') && !e?.taker;

      if (initialRun) {
        const ONE_HOUR_MS = 3600000;

        const moonCatsListings = (moonEvents || [])
          .filter(event => {
            const eventTime = Number(event.event_timestamp || 0) * 1000;
            return (currentTime - eventTime) <= ONE_HOUR_MS && isListingEvent(event);
          })
          .slice(0, 20);

        const oldWrapperListings = (wrapEvents || [])
          .filter(event => {
            const eventTime = Number(event.event_timestamp || 0) * 1000;
            return (currentTime - eventTime) <= ONE_HOUR_MS && isListingEvent(event);
          })
          .slice(0, 20);

        listings = [...moonCatsListings, ...oldWrapperListings];

        if (listings.length > 0) {
          lastProcessedTimestamp = Math.max(...listings.map(event => Number(event.event_timestamp || 0)));
        } else {
          const maxMoon = Math.max(...(moonEvents || []).map(e => Number(e.event_timestamp || 0)), 0);
          const maxWrap = Math.max(...(wrapEvents || []).map(e => Number(e.event_timestamp || 0)), 0);
          lastProcessedTimestamp = Math.max(maxMoon, maxWrap);
        }
      } else {
        const moonCatsListings = (moonEvents || []).filter(event => {
          const isListing = isListingEvent(event);
          return Number(event.event_timestamp || 0) > lastProcessedTimestamp && isListing;
        });

        const oldWrapperListings = (wrapEvents || []).filter(event => {
          const isListing = isListingEvent(event);
          return Number(event.event_timestamp || 0) > lastProcessedTimestamp && isListing;
        });

        listings = [...moonCatsListings, ...oldWrapperListings];

        if (listings.length > 0) {
          lastProcessedTimestamp = Math.max(...listings.map(event => Number(event.event_timestamp || 0)));
        }
      }

      return { listings, rateLimited };
    } catch (error) {
      console.error('Error fetching listings from OpenSea:', error);
      return { listings: [], rateLimited: false };
    }
  }

  async function processListingsQueue() {
    if (isProcessingListings) return;
    isProcessingListings = true;

    LISTINGS_QUEUE.sort((a, b) => (a.event_timestamp || 0) - (b.event_timestamp || 0));

    while (LISTINGS_QUEUE.length > 0) {
      const listing = LISTINGS_QUEUE.shift();
      const orderHash = listing.order_hash;

      if (PROCESSED_LISTINGS.has(orderHash)) continue;

      try {
        const nft = listing.nft || listing.asset;
        const listingContract = (nft?.contract || '').toLowerCase();
        if (!listingContract) continue;

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

        await sleep(LISTING_PROCESS_DELAY_MS);
      } catch (error) {
        console.error(`Error processing listing for orderHash: ${orderHash}`, error);
      }
    }

    isProcessingListings = false;
    if (LISTINGS_QUEUE.length > 0) setImmediate(processListingsQueue);
  }

  async function pollListingsOnce(initial) {
    const { listings, rateLimited } = await fetchListingsFromOpenSea(initial);

    if (listings && listings.length > 0) {
      LISTINGS_QUEUE.push(...listings);
      processListingsQueue();
    }

    if (rateLimited) {
      consecutive429 += 1;
      const bumped = Math.max(BASE_POLL_MS * 2, nextPollMs * 2);
      nextPollMs = Math.min(MAX_BACKOFF_MS, bumped);
      console.log(`OpenSea rate limited (429). backoffMs=${nextPollMs} consecutive429=${consecutive429}`);
    } else {
      consecutive429 = 0;
      nextPollMs = BASE_POLL_MS;
    }

    setTimeout(() => pollListingsOnce(false), nextPollMs);
  }

  /**
   * Attach listing subscriptions onto an existing OpenSea stream client
   * If stream is not available, we keep your existing HTTP polling fallback.
   */
  function attachListingToStreamClient(client) {
    if (!client || !EventType) return false;

    const cutoffSec = Math.floor((Date.now() - 3600000) / 1000);

    const handler = (event) => {
      const normalized = normalizeStreamListingEvent(event);
      if (!normalized) return;
      if (firstRun && normalized.event_timestamp < cutoffSec) return;
      LISTINGS_QUEUE.push(normalized);
      processListingsQueue();
    };

    client.onEvents('acclimatedmooncats', [EventType.ITEM_LISTED], handler);
    client.onEvents('wrapped-mooncatsrescue', [EventType.ITEM_LISTED], handler);

    console.log('Listing bot attached to Unified OpenSea Stream.');
    firstRun = false;
    return true;
  }

  async function monitorListingsWithoutStream() {
    console.log('Listing bot is running (HTTP polling).');
    if (firstRun) {
      firstRun = false;
      await pollListingsOnce(true);
    } else {
      await pollListingsOnce(false);
    }
  }

  return {
    attachListingToStreamClient,
    monitorListingsWithoutStream
  };
}

async function runNameBot() {
  const ALCHEMY_PROJECT_ID = process.env.NAMING_ALCHEMY_PROJECT_ID;
  const DISCORD_WEBHOOK_URL = process.env.NAMING_DISCORD_WEBHOOK_URL;

  let nameWeb3;
  nameWeb3 = new Web3(
    createWeb3Provider(
      ALCHEMY_PROJECT_ID,
      () => nameWeb3,
      'naming'
    )
  );

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

  const moonCatsNamingContract = new nameWeb3.eth.Contract(moonCatsNamingAbi, MOONCATS_NAMING_CONTRACT_ADDRESS);

  function formatCatId(catId) {
    return `0x${catId.slice(2, 12)}`;
  }

  async function getRescueIndex(catId) {
    try {
      const response = await fetch(`https://api.mooncat.community/traits/${catId}`);
      if (!response.ok) throw new Error(`Failed to fetch MoonCat rescue index: ${response.statusText}`);
      const data = await response.json();
      return data.details.rescueIndex;
    } catch (error) {
      console.error('Error fetching rescue index:', error);
      return null;
    }
  }

  async function sendNameToDiscord(catId, name, imageUrl, rescueIndex, transactionHash) {
    const etherScanEmoji = '<:logo_etherscan:1202580047765180498>';
    const txUrl = `https://etherscan.io/tx/${transactionHash}`;

    const payload = {
      username: 'mooncatbot',
      avatar_url: 'https://i.imgur.com/ufCAV5t.gif',
      embeds: [{
        title: 'Named',
        url: `https://chainstation.mooncatrescue.com/mooncats/${rescueIndex}`,
        description: `MoonCat #${rescueIndex}: ${catId} has been named ${name}.`,
        fields: [
          { name: 'Block Explorer', value: `${etherScanEmoji} [Etherscan](${txUrl})`, inline: true }
        ],
        color: 3447003,
        image: { url: imageUrl }
      }]
    };

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Error sending name event to Discord: ${response.statusText}`);
  }

  moonCatsNamingContract.events.CatNamed({ fromBlock: 'latest' })
    .on('data', async (event) => {
      const { catId, catName } = event.returnValues;

      try {
        const formattedCatId = formatCatId(catId);

        let decodedName = '';
        try {
          const rawName = nameWeb3.utils.hexToUtf8(catName);
          decodedName = rawName.replace(/\u0000/g, '').trim();
        } catch (e) {
          console.error('Failed to decode catName bytes32 to utf8:', e);
          return;
        }

        if (isBlockedFullName(decodedName)) {
          console.log(`Blacklisted name detected ("${decodedName}"); skipping naming announcement.`);
          return;
        }

        const rescueIndex = await getRescueIndex(formattedCatId);
        if (!rescueIndex) return;

        const imageUrl = `https://api.mooncat.community/regular-image/${rescueIndex}`;

        await sendNameToDiscord(formattedCatId, decodedName, imageUrl, rescueIndex, event.transactionHash);
      } catch (error) {
        console.error('Error handling CatNamed event:', error);
      }
    })
    .on('error', (error) => {
      console.error('Error receiving CatNamed event:', error);
    });

  console.log('Name bot is running.');
}

const salesBot = runSalesBotStream();
const listingBot = runListingBot();

const unifiedClient = runSalesAndListingUnifiedStream({
  salesAttach: (client) => salesBot?.attachSalesToStreamClient?.(client),
  listingAttach: (client) => listingBot?.attachListingToStreamClient?.(client)
});

if (!unifiedClient) {
  console.error('[stream] Unified stream not running.');
}

if (!unifiedClient || !(listingBot?.attachListingToStreamClient?.(unifiedClient))) {
  listingBot?.monitorListingsWithoutStream?.();
}

runNameBot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot is running on port ${PORT}`);
});
