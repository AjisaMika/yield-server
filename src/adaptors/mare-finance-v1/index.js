const superagent = require('superagent');
const sdk = require('@defillama/sdk');

const utils = require('../utils');
const { comptrollerAbi, ercDelegator, distributorAbi } = require('./abi');

const COMPTROLLER_ADDRESS = '0x4804357AcE69330524ceb18F2A647c3c162E1F95';
const REWARD_DISTRIBUTOR = '0x4804357AcE69330524ceb18F2A647c3c162E1F95';
const CHAIN = 'kava';
const GET_ALL_MARKETS = 'getAllMarkets';
const SUPPLY_RATE = 'supplyRatePerBlock';
const BORROW_RATE = 'borrowRatePerBlock';
const REWARD_SPEEDS = 'compSupplySpeeds';
const BORROW_SPEEDS = 'compBorrowSpeeds';
const TOTAL_BORROWS = 'totalBorrows';
const GET_CHASH = 'getCash';
const UNDERLYING = 'underlying';
const SECONDS_PER_DAY = 86400;
const BLOCKS_PER_DAY = SECONDS_PER_DAY;

const PROJECT_NAME = 'mare-finance-v1';

const NATIVE_TOKEN = {
  decimals: 18,
  symbol: 'WKAVA',
  address: '0xc86c7C0eFbd6A49B35E8714C5f59D99De09A225b'.toLowerCase(),
};

const PROTOCOL_TOKEN = {
  decimals: 18,
  symbol: 'MARE',
  address: '0xd86C8d4279CCaFbec840c782BcC50D201f277419'.toLowerCase(),
};

const getRewards = async (markets, isBorrow) => {
  return (
    await sdk.api.abi.multiCall({
      chain: CHAIN,
      calls: markets.map((market) => ({
        target: REWARD_DISTRIBUTOR,
        params: [market],
      })),
      abi: distributorAbi.find(
        ({ name }) => name === (isBorrow ? BORROW_SPEEDS : REWARD_SPEEDS)
      ),
    })
  ).output.map(({ output }) => output);
};

const getPrices = async (addresses) => {
  const prices = (
    await superagent.get(
      `https://coins.llama.fi/prices/current/${addresses
        .join(',')
        .toLowerCase()}`
    )
  ).body.coins;

  const pricesByAddress = Object.entries(prices).reduce(
    (acc, [name, price]) => ({
      ...acc,
      [name.split(':')[1]]: price.price,
    }),
    {}
  );

  return pricesByAddress;
};

const calculateApy = (ratePerTimestamps) => {
  const blocksPerDay = BLOCKS_PER_DAY;
  const daysPerYear = 365;

  return (
    (Math.pow(ratePerTimestamps * blocksPerDay + 1, daysPerYear) - 1) * 100
  );
};

const multiCallMarkets = async (markets, method, abi) => {
  return (
    await sdk.api.abi.multiCall({
      chain: CHAIN,
      calls: markets.map((market) => ({ target: market })),
      abi: abi.find(({ name }) => name === method),
    })
  ).output.map(({ output }) => output);
};

const lendingApy = async () => {
  const allMarketsRes = (
    await sdk.api.abi.call({
      target: COMPTROLLER_ADDRESS,
      chain: CHAIN,
      abi: comptrollerAbi.find(({ name }) => name === GET_ALL_MARKETS),
    })
  ).output;

  const allMarkets = Object.values(allMarketsRes);

  const marketsInfo = (
    await sdk.api.abi.multiCall({
      chain: CHAIN,
      calls: allMarkets.map((market) => ({
        target: COMPTROLLER_ADDRESS,
        params: market,
      })),
      abi: comptrollerAbi.find(({ name }) => name === 'markets'),
    })
  ).output.map(({ output }) => output);

  const supplyRewards = await multiCallMarkets(
    allMarkets,
    SUPPLY_RATE,
    ercDelegator
  );

  const borrowRewards = await multiCallMarkets(
    allMarkets,
    BORROW_RATE,
    ercDelegator
  );

  const distributeRewards = await getRewards(allMarkets);
  const distributeBorrowRewards = await getRewards(allMarkets, true);

  const marketsCash = await multiCallMarkets(
    allMarkets,
    GET_CHASH,
    ercDelegator
  );

  const totalBorrows = await multiCallMarkets(
    allMarkets,
    TOTAL_BORROWS,
    ercDelegator
  );

  const underlyingTokens = await multiCallMarkets(
    allMarkets,
    UNDERLYING,
    ercDelegator
  );

  const underlyingSymbols = await multiCallMarkets(
    underlyingTokens,
    'symbol',
    ercDelegator
  );

  const underlyingDecimals = await multiCallMarkets(
    underlyingTokens,
    'decimals',
    ercDelegator
  );

  const prices = await getPrices(
    underlyingTokens
      .concat([NATIVE_TOKEN.address])
      .concat([PROTOCOL_TOKEN.address])
      .map((token) => `${CHAIN}:` + token)
  );

  const pools = allMarkets.map((market, i) => {
    const symbol = underlyingSymbols[i] || NATIVE_TOKEN.symbol;
    const token =
      symbol === 'KAVA' ? NATIVE_TOKEN.address : underlyingTokens[i];

    const decimals = Number(underlyingDecimals[i]) || NATIVE_TOKEN.decimals;
    let price = prices[token.toLowerCase()];
    if (price === undefined)
      price = symbol.toLowerCase().includes('usd') ? 1 : 0;

    const totalSupplyUsd =
      ((Number(marketsCash[i]) + Number(totalBorrows[i])) / 10 ** decimals) *
      price;
    const tvlUsd = (marketsCash[i] / 10 ** decimals) * price;

    const totalBorrowUsd = (Number(totalBorrows[i]) / 10 ** decimals) * price;

    const apyBase = calculateApy(supplyRewards[i] / 10 ** 18);
    const apyBaseBorrow = calculateApy(borrowRewards[i] / 10 ** 18);

    const apyReward =
      (((distributeRewards[i] / 10 ** PROTOCOL_TOKEN.decimals) *
        SECONDS_PER_DAY *
        365 *
        prices[PROTOCOL_TOKEN.address]) /
        totalSupplyUsd) *
      100;

    const apyRewardBorrow =
      (((distributeBorrowRewards[i] / 10 ** PROTOCOL_TOKEN.decimals) *
        SECONDS_PER_DAY *
        365 *
        prices[PROTOCOL_TOKEN.address]) /
        totalBorrowUsd) *
      100;

    return {
      pool: market,
      chain: CHAIN,
      project: PROJECT_NAME,
      symbol,
      tvlUsd,
      apyBase,
      apyReward,
      underlyingTokens: [token],
      rewardTokens: [apyReward > 0 ? PROTOCOL_TOKEN.address : null].filter(
        Boolean
      ),
      totalSupplyUsd,
      totalBorrowUsd,
      apyBaseBorrow,
      apyRewardBorrow,
      ltv: marketsInfo[i].collateralFactorMantissa / 10 ** 18,
    };
  });

  return pools;
};

module.exports = {
  timetravel: false,
  apy: lendingApy,
  url: 'https://mare.finance/',
};
