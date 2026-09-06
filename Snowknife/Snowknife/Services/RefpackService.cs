namespace Snowknife.Services;

/// <summary>
/// RefPack (EA LZ77) compression. A fast greedy hash-chain compressor whose output starts <c>10 FB</c> and
/// decompresses with the stock decoder - the library's "Max" level takes 20+ minutes on a 4 MB file, so this
/// is what the repack path uses to compress a single regenerated member before re-containering.
/// </summary>
internal sealed class RefpackService
{
    // RefPack-compress one file with a fast hash-chain compressor (the library's "Max" level takes 20+ min
    // on a 4 MB file). Output starts 10 FB and decompresses with the stock decoder; use it to compress a
    // single regenerated member before re-containering with `big-create --store`.
    public int Refpack(string[] args)
    {
        if (args.Length < 3) { Log.Error("refpack needs <in> <out>"); return 1; }
        byte[] raw = File.ReadAllBytes(args[1]);
        byte[] packed = Compress(raw);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(args[2]))!);
        File.WriteAllBytes(args[2], packed);
        Log.Info($"RefPack: {raw.Length:n0} -> {packed.Length:n0} bytes ({100.0 * packed.Length / Math.Max(1, raw.Length):f1}%)");
        return 0;
    }

    // Greedy LZ77 with a bounded hash chain, emitting standard RefPack commands (header 10 FB + u24 size).
    public byte[] Compress(byte[] src)
    {
        int n = src.Length;
        if (n > 0xFFFFFF) throw new NotSupportedException("RefpackCompress: inputs over 16 MB need the u32 header (not implemented).");
        var o = new List<byte>(n / 2 + 16) { 0x10, 0xFB, (byte)(n >> 16), (byte)(n >> 8), (byte)n };

        const int MAX_DIST = 131072, HASH_SIZE = 1 << 16, MAX_CHAIN = 64;
        int[] head = new int[HASH_SIZE];
        int[] prev = new int[Math.Max(1, n)];
        Array.Fill(head, -1);
        int Hash(int i) => ((src[i] << 10) ^ (src[i + 1] << 5) ^ src[i + 2]) & (HASH_SIZE - 1);

        // emit [from, from+len) as form-4 literal runs (multiples of 4, <=112); return the 0-3 leftover
        int EmitRuns(int from, int len)
        {
            int i = from, rem = len;
            while (rem >= 4)
            {
                int chunk = Math.Min(112, rem & ~3);
                o.Add((byte)(0xE0 | ((chunk - 4) >> 2)));
                for (int k = 0; k < chunk; k++) o.Add(src[i + k]);
                i += chunk; rem -= chunk;
            }
            return rem;
        }
        // command bytes, then `litCount` (0-3) literals copied from litFrom, then the implicit back-ref
        void EmitMatch(int litFrom, int litCount, int len, int dist)
        {
            int d = dist - 1;
            if (dist <= 1024 && len <= 10) // form 1
            {
                o.Add((byte)((litCount & 3) | (((len - 3) & 7) << 2) | (((d >> 8) & 3) << 5)));
                o.Add((byte)(d & 0xFF));
            }
            else if (dist <= 16384 && len <= 67) // form 2
            {
                o.Add((byte)(0x80 | ((len - 4) & 0x3F)));
                o.Add((byte)(((litCount & 3) << 6) | ((d >> 8) & 0x3F)));
                o.Add((byte)(d & 0xFF));
            }
            else // form 3
            {
                int ml = len - 5;
                o.Add((byte)(0xC0 | (litCount & 3) | (((ml >> 8) & 3) << 2) | (((d >> 16) & 1) << 4)));
                o.Add((byte)((d >> 8) & 0xFF));
                o.Add((byte)(d & 0xFF));
                o.Add((byte)(ml & 0xFF));
            }
            for (int k = 0; k < litCount; k++) o.Add(src[litFrom + k]);
        }
        static bool Encodable(int len, int dist) =>
            (len >= 3 && len <= 10 && dist <= 1024) ||
            (len >= 4 && len <= 67 && dist <= 16384) ||
            (len >= 5 && len <= 1028 && dist <= 131072);
        static int CapLen(int len, int dist) // longest length encodable for this distance
        {
            int cap = 0;
            if (dist <= 1024) cap = Math.Max(cap, Math.Min(len, 10));
            if (dist <= 16384) cap = Math.Max(cap, Math.Min(len, 67));
            if (dist <= 131072) cap = Math.Max(cap, Math.Min(len, 1028));
            return cap;
        }

        int pos = 0, litStart = 0;
        while (pos < n)
        {
            int bestLen = 0, bestDist = 0;
            if (pos + 3 <= n)
            {
                int cand = head[Hash(pos)], chain = 0, maxLen = Math.Min(1028, n - pos);
                while (cand >= 0 && chain < MAX_CHAIN)
                {
                    int dist = pos - cand;
                    if (dist > MAX_DIST) break;
                    int l = 0;
                    while (l < maxLen && src[cand + l] == src[pos + l]) l++;
                    if (l >= 3 && l > bestLen && Encodable(l, dist)) { bestLen = l; bestDist = dist; }
                    cand = prev[cand]; chain++;
                }
            }
            if (bestLen >= 3)
            {
                int len = CapLen(bestLen, bestDist);
                int r = EmitRuns(litStart, pos - litStart);
                EmitMatch(pos - r, r, len, bestDist);
                for (int end = pos + len; pos < end; pos++) if (pos + 3 <= n) { int hh = Hash(pos); prev[pos] = head[hh]; head[hh] = pos; }
                litStart = pos;
            }
            else
            {
                if (pos + 3 <= n) { int hh = Hash(pos); prev[pos] = head[hh]; head[hh] = pos; }
                pos++;
            }
        }
        int rr = EmitRuns(litStart, n - litStart);
        o.Add((byte)(0xFC | (rr & 3)));
        for (int k = 0; k < rr; k++) o.Add(src[n - rr + k]);
        return o.ToArray();
    }
}
