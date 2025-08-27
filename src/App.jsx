import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import abi from "./abi/Leaderboard.json";
import "./App.css";

const CONTRACT_ADDRESS = import.meta.env.VITE_LEADERBOARD_ADDRESS;
const MONAD_RPC = "https://testnet-rpc.monad.xyz";
const ALCHEMY_URL =
  "https://monad-testnet.g.alchemy.com/v2/t8TcyfIGJYS3otYySM2t6";

function shortenAddress(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function formatVolumeHuman(num) {
  if (!isFinite(num) || num === 0) return "0";
  const abs = Math.abs(num);

  if (abs < 1000) return Number(num.toFixed(2)).toString();

  const units = ["", "k", "M", "B", "T"];
  let unitIndex = 0;
  let value = num;
  while (Math.abs(value) >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex++;
  }

  const formatted =
    Math.abs(value) >= 100 ? Math.round(value).toString() : value.toFixed(1);

  return `${formatted}${units[unitIndex]}`;
}

async function sumTransfersRaw(paramsBase) {
  let pageKey = undefined;
  let totalRaw = 0n;

  do {
    const params = { ...paramsBase };
    if (pageKey) params.pageKey = pageKey;

    const res = await fetch(ALCHEMY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [params],
      }),
    });

    const data = await res.json();
    const transfers = data.result?.transfers || [];

    for (const tx of transfers) {
      if (!tx.value) continue;

      try {
        let val;
        if (typeof tx.value === "string" && tx.value.startsWith("0x")) {
          val = BigInt(tx.value);
        } else {
          val = BigInt(Math.floor(Number(tx.value)));
        }
        totalRaw += val;
      } catch (e) {
        console.warn("Skipping unparsable transfer value:", tx.value, e);
      }
    }

    pageKey = data.result?.pageKey;
  } while (pageKey);

  return totalRaw;
}

async function getWalletVolume(address) {
  try {
    const outRaw = await sumTransfersRaw({
      fromBlock: "0x0",
      toBlock: "latest",
      fromAddress: address,
      category: ["external"],
    });

    const inRaw = await sumTransfersRaw({
      fromBlock: "0x0",
      toBlock: "latest",
      toAddress: address,
      category: ["external"],
    });

    const totalRaw = outRaw + inRaw;
    const volumeNum = Number(totalRaw);
    return isFinite(volumeNum) ? volumeNum : 0;
  } catch (err) {
    console.error("Failed to fetch wallet volume:", err);
    return 0;
  }
}

export default function App() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [gameSubmitting, setGameSubmitting] = useState(false);

  const GAME_TX_AMOUNT = 5;
  const OPTIMISTIC_TX_VALUE = 0.000001; // Ether per click

  function calculateScores(volumes) {
    const maxVolume = Math.max(...volumes);
    return volumes.map((v) =>
      Math.max(100, Math.floor((v / maxVolume) * 100000))
    );
  }

  async function fetchLeaderboard() {
    try {
      setLoading(true);
      const provider = new ethers.JsonRpcProvider(MONAD_RPC);
      const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);
      const [addrs] = await contract.getAll();

      const list = await Promise.all(
        addrs.map(async (a) => {
          const vol = await getWalletVolume(a);
          return { address: a, volume: vol };
        })
      );

      const volumes = list.map((l) => l.volume);
      const scores = calculateScores(volumes);

      const finalList = list.map((l, idx) => ({
        ...l,
        score: scores[idx],
        volume: formatVolumeHuman(l.volume),
      }));

      finalList.sort((a, b) => b.score - a.score);
      setEntries(finalList);
    } catch (e) {
      console.error("Failed to fetch leaderboard:", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchLeaderboard();
  }, []);

  const ranked = useMemo(
    () => entries.map((e, idx) => ({ rank: idx + 1, ...e })),
    [entries]
  );

  async function connectWallet() {
    if (!window.ethereum) {
      alert("Please install MetaMask (or a Monad-compatible wallet).");
      return;
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const [addr] = await provider.send("eth_requestAccounts", []);
    setAccount(addr);
    await updateScore(addr, provider);
  }

  async function refreshScore() {
    if (!account || !window.ethereum) return;
    const provider = new ethers.BrowserProvider(window.ethereum);
    await updateScore(account, provider);
  }

  async function updateScore(addr, provider) {
    setSubmitting(true);
    try {
      await fetchLeaderboard();
    } finally {
      setSubmitting(false);
    }
  }

  async function playBreakMonad() {
    if (!account || !window.ethereum) {
      alert("Connect your wallet first!");
      return;
    }

    setGameSubmitting(true);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      // Send transactions
      for (let i = 0; i < GAME_TX_AMOUNT; i++) {
        const tx = await signer.sendTransaction({
          to: account,
          value: ethers.parseEther(OPTIMISTIC_TX_VALUE.toString()),
        });
        await tx.wait();
      }

      // Optimistic Update: immediately increase user's volume in UI
      setEntries((prev) => {
        return prev.map((e) => {
          if (e.address === account) {
            const updatedVolume = e.volume.replace(/[^\d\.]/g, "") * 1 + GAME_TX_AMOUNT * OPTIMISTIC_TX_VALUE;
            return {
              ...e,
              volume: formatVolumeHuman(updatedVolume),
              score: Math.max(100, Math.floor((updatedVolume / Math.max(...prev.map(p => parseFloat(p.volume.replace(/[^\d\.]/g,""))))) * 100000))
            };
          }
          return e;
        });
      });

    } catch (err) {
      console.error("Break Monad failed:", err);
      alert("Failed to send transactions. Ensure enough balance on testnet.");
    } finally {
      setGameSubmitting(false);
    }
  }

  const topRanked = useMemo(() => {
    if (!account) return ranked.slice(0, 10);

    const userEntry = ranked.find((r) => r.address === account);
    let list = ranked.slice(0, 10);

    if (userEntry && !list.some((r) => r.address === account)) {
      list.push(userEntry);
    }
    return list;
  }, [ranked, account]);

  return (
    <div className="min-h-screen bg-purple-900 flex items-center justify-center text-white p-6">
      <div className="flex flex-col items-center justify-center w-full max-w-3xl space-y-6">

        {/* Break Monad Game at Top */}
        <div className="bg-purple-800/40 border border-purple-400 rounded-2xl shadow-xl p-6 w-auto max-w-3xl flex flex-col items-center space-y-3">
          <h2 className="text-2xl font-semibold text-center">Play Break Monad Game</h2>
          <p className="text-center">
            Click the button to send 5 transactions at once and increase your
            Score
          </p>
          <button
            onClick={playBreakMonad}
            className="px-6 py-3 bg-purple-600 hover:bg-purple-500 rounded-lg font-semibold"
            disabled={gameSubmitting || !account}
          >
            {gameSubmitting ? "Sending Transactions…" : "Break Monad!"}
          </button>
        </div>

        <h1 className="text-4xl font-bold text-center">Monad Leaderboard</h1>

        {/* Wallet info */}
        <div className="bg-purple-800/40 border border-purple-400 rounded-2xl shadow-xl p-6 w-auto max-w-3xl text-left">
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
            <div className="flex-1">
              <label className="block text-sm mb-1 opacity-90">
                Connected wallet
              </label>
              <div className="px-3 py-2 bg-purple-950/60 rounded-lg border border-purple-600 overflow-hidden text-ellipsis">
                {account ? shortenAddress(account) : "Not connected"}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={connectWallet}
                className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 font-semibold disabled:opacity-50"
                disabled={submitting}
              >
                {account ? "Reconnect" : "Connect Wallet"}
              </button>

              {account && (
                <button
                  onClick={refreshScore}
                  className="px-4 py-2 rounded-lg bg-purple-500 hover:bg-purple-400 font-semibold disabled:opacity-50"
                  disabled={submitting}
                >
                  Refresh Score
                </button>
              )}
            </div>
          </div>

          <p className="text-xs opacity-75 mt-2 text-center sm:text-left">
            Scores are based on wallet activity. Highest score = 100,000. Minimum = 100.
          </p>
        </div>

        {/* Leaderboard Table */}
        <div className="bg-purple-800/40 border border-purple-400 rounded-2xl shadow-xl p-6 w-auto max-w-3xl">
          <div className="flex justify-center">
            <table className="w-auto">
              <thead className="bg-purple-700">
                <tr>
                  <th className="px-6 py-3 text-left">Rank</th>
                  <th className="px-6 py-3 text-left">Address</th>
                  <th className="px-6 py-3 text-left">Volume</th>
                  <th className="px-6 py-3 text-left">Score</th>
                </tr>
              </thead>
              <tbody className="bg-purple-800/40">
                {loading ? (
                  <tr>
                    <td className="px-6 py-3" colSpan={4}>
                      Loading…
                    </td>
                  </tr>
                ) : topRanked.length === 0 ? (
                  <tr>
                    <td className="px-6 py-3" colSpan={4}>
                      No entries yet. Be the first to connect!
                    </td>
                  </tr>
                ) : (
                  topRanked.map((p) => (
                    <tr
                      key={p.address}
                      className="border-t border-purple-500/50"
                    >
                      <td className="px-6 py-3">{p.rank}</td>
                      <td className="px-6 py-3">{shortenAddress(p.address)}</td>
                      <td className="px-6 py-3">{p.volume}</td>
                      <td className="px-6 py-3">{p.score}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {ranked.length > 10 && (
            <div className="mt-2 text-center">
              <button
                className="text-purple-300 hover:text-white underline"
                onClick={() => window.scrollTo({ top: 1000, behavior: "smooth" })}
              >
                View Full Leaderboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
