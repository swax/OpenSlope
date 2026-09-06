// A few tests capture Console output (the CLI's help index writes straight to Console.Out), which is
// process-global. The whole suite runs in well under a second, so serializing it costs nothing and removes
// that class of interference outright.
[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]
