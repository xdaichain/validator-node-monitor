const http = require('http');
const Web3 = require('web3');
// const Timeout = require('await-timeout');
// const BN = web3.utils.BN;

const BLOCKS_SCAN_PERIOD = 100; // in seconds
const BLOCKS_SCAN_RANGE = 100; // in blocks
const RPC_REQUEST_TIMEOUT = 10; // in seconds
const RPC_HANG_AVG_BLOCKTIME = 8; // in seconds

const rpcList = process.env.RPC.split(',');
//const rpcList = ["https://rpc.xdaichain.com/", "http://test"];
const web3 = [];
for (let i = 0; i < rpcList.length; i++) {
  web3.push(new Web3(rpcList[i].trim()));
}

let lastValidatorBlockNumber = 0;
let veryFirstKnownBlock = null;
let prevKnownBlock = null;
let latestKnownBlock = null;
let isValidatorOK = true;

const server = http.createServer(async (req, res) => {
  res.writeHead(isValidatorOK ? 200 : 503, { 'Content-Type': 'text/plain' });
  res.end();
});
server.listen(8080);

mainLoop();

async function mainLoop() {
  const latestBlock = await getLatestBlock();
  if (latestBlock) {
    if (latestBlock.number <= BLOCKS_SCAN_RANGE || latestKnownBlock && latestBlock.number < latestKnownBlock.number + 2) {
      // we are at the beginning of the chain or the blocks are too slow, so skip this iteration
      nextIteration(true);
      return;
    }

    const validator = await isValidator();
    if (validator !== null) {
      let firstBlockNumber;
      if (prevKnownBlock) {
        firstBlockNumber = latestKnownBlock.number + 1;
      } else {
        // if this is the first run, we scan the latest BLOCKS_SCAN_RANGE blocks
        firstBlockNumber = latestBlock.number - BLOCKS_SCAN_RANGE;
      }
      const firstBlock = await scanLastBlocks(firstBlockNumber, latestBlock.number - 1);
      if (firstBlock) {
        const prevBlock = !prevKnownBlock ? firstBlock : latestKnownBlock;
        const avgBlockTime = (latestBlock.timestamp - prevBlock.timestamp) / (latestBlock.number - prevBlock.number);

        if (avgBlockTime <= RPC_HANG_AVG_BLOCKTIME) {
          // rpc nodes are not hanging
          prevKnownBlock = prevBlock;
          latestKnownBlock = latestBlock;
          if (!veryFirstKnownBlock) {
            veryFirstKnownBlock = prevBlock;
          }

          if (latestBlock.number - lastValidatorBlockNumber > BLOCKS_SCAN_RANGE && veryFirstKnownBlock && validator) {
            nextIteration(false);
          } else {
            nextIteration(true);
          }
          return;
        }
      }
    }
  }

  nextIteration(true);
}

function nextIteration(_isValidatorOK) {
  isValidatorOK = _isValidatorOK;
  setTimeout(mainLoop, BLOCKS_SCAN_PERIOD * 1000);
}

async function getLatestBlock() {
  let latestBlock = null;
  let resolvedCount = 0;
  let timeout = setTimeout(() => {
    resolvedCount = web3.length;
  }, RPC_REQUEST_TIMEOUT * 1000);
  for (let i = 0; i < web3.length; i++) {
    web3[i].eth.getBlock('latest', false, (error, result) => {
      if (timeout != null) {
        if (!error && result && result.number) {
          if (latestBlock == null || result.number > latestBlock.number) {
            latestBlock = result;
          }
        }
        resolvedCount++;
      }
    });
  }
  while (resolvedCount < web3.length) {
    await sleep(10);
  }
  clearTimeout(timeout);
  timeout = null;
  return latestBlock;
}

async function isValidator() {
  const abi = [{"constant":true,"inputs":[{"name":"_miningAddress","type":"address"}],"name":"isValidator","outputs":[{"name":"","type":"bool"}],"payable":false,"stateMutability":"view","type":"function"}];
  let flag = null;
  let expired = false;
  let timeout = setTimeout(() => {
    expired = true;
  }, RPC_REQUEST_TIMEOUT * 1000);
  for (let i = 0; i < web3.length; i++) {
    const validatorSetAuRaContract = new web3[i].eth.Contract(abi, process.env.VALIDATOR_SET_ADDRESS);
    validatorSetAuRaContract.methods.isValidator(process.env.MINING_ADDRESS).call({}, 'latest', (error, result) => {
      if (timeout != null && !error) {
        flag = result;
      }
    });
  }
  while (flag === null && !expired) {
    await sleep(10);
  }
  clearTimeout(timeout);
  timeout = null;
  return flag;
}

async function scanLastBlocks(first, last) {
  const maxResolvedCount = web3.length * (last - first + 1);
  let firstBlock = null;
  let resolvedCount = 0;
  let timeout = setTimeout(() => {
    resolvedCount = maxResolvedCount;
  }, RPC_REQUEST_TIMEOUT * 1000);
  for (let i = 0; i < web3.length; i++) {
    let batch = new web3[i].BatchRequest();
    for (let b = first; b <= last; b++) {
      batch.add(web3[i].eth.getBlock.request(b, false, (error, block) => {
        if (timeout != null) {
          if (!error && block) {
            if (b == first) {
              if (!firstBlock || block.timestamp > firstBlock.timestamp) {
                firstBlock = block;
              }
            }
            if (block.miner.toLowerCase() == process.env.MINING_ADDRESS.toLowerCase().trim() && block.number > lastValidatorBlockNumber) {
              lastValidatorBlockNumber = block.number;
            }
          }
          resolvedCount++;
        }
      }));
    }
    batch.execute();
  }
  while (resolvedCount < maxResolvedCount) {
    await sleep(10);
  }
  clearTimeout(timeout);
  timeout = null;
  return firstBlock;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
