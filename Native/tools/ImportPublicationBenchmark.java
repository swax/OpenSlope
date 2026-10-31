package org.openslope.nativeplayer;

import java.io.File;
import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONObject;

/** Device-side timing of the production local publisher; no app update or existing Maps changes. */
public final class ImportPublicationBenchmark {

    private static void inventory(File directory, long[] totals) throws IOException {
        File[] files = directory.listFiles();
        if (files == null) throw new IOException("Cannot inventory benchmark output");
        for (File file : files) {
            if (file.isDirectory()) inventory(file, totals);
            else {
                ++totals[0];
                totals[1] += file.length();
            }
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException(
            "Usage: <extracted-course> <new-internal-work> <new-external-Maps>"
        );
        File input = new File(args[0]),
            internal = new File(args[1]),
            maps = new File(args[2]);
        if (!new File(input, "Patches.json").isFile() || !internal.mkdir() || !maps.mkdir()) throw new IOException(
            "Use a valid extracted course and fresh benchmark directories"
        );
        File source = new File(internal, "source");
        if (!source.mkdir()) throw new IOException("Cannot stage benchmark source");
        MapLibrary.copyLocal(input, source, () -> {});
        MapLibrary library = new MapLibrary(null, maps, null);
        long[] expected = new long[2];
        inventory(source, expected);
        JSONArray rows = new JSONArray();
        for (int run = 0; run < 5; ++run) {
            for (int operation = 0; operation < 2; ++operation) {
                boolean rename = (run % 2 == 0 ? operation : 1 - operation) == 1;
                String name = (rename ? "rename-" : "copy-") + run;
                File prepared = source;
                if (rename) {
                    // Production extraction writes directly to this external
                    // staging folder. Fixture setup is outside publication time.
                    prepared = library.importPath(internal);
                    if (!prepared.mkdir()) throw new IOException("Cannot stage rename fixture");
                    MapLibrary.copyLocal(source, prepared, () -> {});
                }
                long begin = System.nanoTime();
                if (rename) library.publishImport(name, prepared, () -> {});
                else library.publish(name, prepared, () -> {});
                double elapsed = (System.nanoTime() - begin) / 1000000.;
                long[] actual = new long[2];
                inventory(new File(maps, name), actual);
                if (
                    actual[0] != expected[0] || actual[1] != expected[1] || (rename && prepared.exists())
                ) throw new IOException("Publication inventory or staging consumption differs");
                rows.put(
                    new JSONObject()
                        .put("method", rename ? "rename" : "copy")
                        .put("run", run)
                        .put("elapsed_ms", elapsed)
                        .put("output_files", actual[0])
                        .put("output_bytes", actual[1])
                );
            }
        }
        System.out.println(new JSONObject().put("runs", rows).toString(2));
    }
}
