package org.openslope.nativeplayer;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Arrays;

/** Run on a host JVM with android.jar: the local publication path uses ordinary files only. */
public final class LocalImportPublicationTest {
    private static int checks;
    private static void require(boolean condition, String message) {
        ++checks;
        if (!condition) throw new AssertionError(message);
    }
    private static void rejects(MapLibrary library, String name, File source, MapLibrary.Cancel cancel) throws Exception {
        boolean rejected = false;
        try { library.publishImport(name, source, cancel); } catch (IOException e) { rejected = true; }
        require(rejected && source.isDirectory(), "Rejected publication must preserve its source");
    }
    public static void main(String[] args) throws Exception {
        File root = new File(args[0]).getAbsoluteFile();
        require(root.mkdir(), "Use a new isolated test directory");
        try {
            File maps = new File(root, "Maps"), cache = new File(root, "cache");
            require(cache.mkdir(), "Create cache");
            MapLibrary library = new MapLibrary(null, maps, null);
            File staging = library.importPath(cache);
            require(!staging.exists() && staging.getParentFile().equals(maps), "Stage on the destination filesystem");
            require(staging.mkdir(), "Extraction owns creation of staging");
            byte[] payload = new byte[128 * 1024];
            for (int i = 0; i < payload.length; ++i) payload[i] = (byte) i;
            Files.write(new File(staging, "Patches.json").toPath(), payload);
            library.publishImport("Course", staging, () -> {});
            require(!staging.exists(), "Local publication consumes staging by rename");
            require(Arrays.equals(Files.readAllBytes(new File(maps, "Course/Patches.json").toPath()), payload), "Publication preserves every byte");
            File interrupted = library.importPath(cache);
            require(interrupted.mkdir(), "Create interrupted import");
            rejects(library, "Course", interrupted, () -> {});
            rejects(library, "Cancelled", interrupted, () -> { throw new IOException("cancelled"); });
            require(!new File(maps, "Cancelled").exists(), "Cancellation must leave no published map");
            rejects(library, "../invalid", interrupted, () -> {});
            File outside = new File(cache, ".openslope-import-outside");
            require(outside.mkdir(), "Create outside source");
            rejects(library, "Outside", outside, () -> {});
            File custom = new File(maps, "Custom source");
            require(custom.mkdir(), "Create unrelated source");
            rejects(library, "Unowned", custom, () -> {});
            require(Arrays.equals(Files.readAllBytes(new File(maps, "Course/Patches.json").toPath()), payload), "Failures preserve existing courses");
            System.out.println("PASS: " + checks + " local import publication checks");
        } finally {
            MapLibrary.deleteLocal(root);
        }
    }
}
