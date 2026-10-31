using System.Buffers.Binary;
using System.Text;
using Snowknife.Services;

namespace Snowknife.Tests.Services;

public class CourseTitlesTests
{
    static byte[] Executable()
    {
        byte[] bytes = new byte[4096];
        bytes[0] = 127; Encoding.ASCII.GetBytes("ELF").CopyTo(bytes, 1); bytes[4] = bytes[5] = 1;
        Word(bytes, 28, 52); Half(bytes, 42, 32); Half(bytes, 44, 1);
        Word(bytes, 52, 1); Word(bytes, 56, 256); Word(bytes, 60, 0x100000); Word(bytes, 68, 3840);
        return bytes;
    }
    static void Word(byte[] bytes, int p, uint value) => BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(p, 4), value);
    static void Half(byte[] bytes, int p, ushort value) => BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(p, 2), value);
    static void Text(byte[] bytes, int p, string value) => Encoding.ASCII.GetBytes(value).CopyTo(bytes, p);
    static void Row(byte[] bytes, int p, uint ordinal, int strings, string code, string title)
    {
        Word(bytes, p, ordinal);
        Word(bytes, p + 4, (uint)(0x100000 + strings - 256)); Text(bytes, strings, title);
        Word(bytes, p + 8, (uint)(0x100000 + strings + 80 - 256)); Text(bytes, strings + 80, "MENU_KEY");
        Word(bytes, p + 20, (uint)(0x100000 + strings + 120 - 256)); Text(bytes, strings + 120, code);
    }
    [Fact]
    public void TrickyTitlesComeFromDescriptorPointers()
    {
        var bytes = Executable();
        Row(bytes, 512, 0, 1024, "GARI", "A source-authored title");
        Row(bytes, 540, 1, 1280, "SNOW", "Another source title");
        Assert.Equal("A source-authored title", CourseTitles.Read(bytes, "GARI"));
        Assert.Equal("A source-authored title", CourseTitles.Read(bytes, "tricky_gari"));
        Assert.Equal("Another source title", CourseTitles.Read(bytes, "SNOW"));
        Assert.Null(CourseTitles.Read(bytes, "MISSING"));
        Word(bytes, 516, uint.MaxValue);
        Assert.Null(CourseTitles.Read(bytes, "GARI"));
    }
    [Fact]
    public void Ssx3TitlesAndConnectorsUseTheSourceSections()
    {
        var bytes = Executable();
        Text(bytes, 512, "Source Station"); Text(bytes, 560, "A"); Text(bytes, 576, "BAM");
        Text(bytes, 612, "Source Run"); Text(bytes, 660, "ARA1"); Text(bytes, 676, "BAM");
        Assert.Equal("Source Run", CourseTitles.Read(bytes, "SSX3_ARA1"));
        Assert.Equal("Source Station / Source Run", CourseTitles.Read(bytes, "SSX3_A_ARA1"));
        Assert.Equal("Peak 1", CourseTitles.Read(bytes, "SSX3_PEAK1"));
        Assert.Null(CourseTitles.Read(bytes, "SSX3_UNKNOWN"));
        Assert.Null(CourseTitles.Read(new byte[20], "SSX3_ARA1"));
    }
}
