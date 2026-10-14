#include "openslope/audio.hpp"
#include "import_internal.hpp"
#include <fstream>
#include <bit>

namespace openslope {
using import_detail::Bytes;
PcmClip PcmClip::load(const std::filesystem::path& path){
    const auto size=std::filesystem::file_size(path);if(size<44||size>64*1024*1024)throw std::runtime_error("WAV extent exceeds its limits");std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));std::ifstream file(path,std::ios::binary);file.read(reinterpret_cast<char*>(bytes.data()),std::streamsize(size));if(!file)throw std::runtime_error("Cannot read WAV");Bytes b{bytes};
    if(b.text(0,4)!="RIFF"||b.text(8,4)!="WAVE"||std::uint64_t(b.le(4))+8!=size)throw std::runtime_error("Invalid RIFF/WAVE extent");PcmClip clip;unsigned format=0,bits=0,align=0;std::size_t offset=0,length=0;bool have_format=false,have_data=false;
    for(std::size_t p=12;p<size;){b.range(p,8);const auto count=b.le(p+4);b.range(p+8,count);const auto kind=b.text(p,4);
        if(kind=="fmt "){if(have_format||count<16)throw std::runtime_error("Invalid WAV format chunk");have_format=true;format=b.le(p+8,2);clip.channels=b.le(p+10,2);clip.rate=b.le(p+12);align=b.le(p+20,2);bits=b.le(p+22,2);if(clip.channels<1||clip.channels>2||clip.rate<8000||clip.rate>192000||align!=clip.channels*((bits+7)/8)||b.le(p+16)!=clip.rate*align)throw std::runtime_error("Invalid WAV channel/rate layout");}
        if(kind=="data"){if(have_data)throw std::runtime_error("Duplicate WAV data chunk");have_data=true;offset=p+8;length=count;}
        p+=8+count+(count&1);if(p>size)throw std::runtime_error("Truncated WAV chunk padding");
    }
    if(!have_format||!have_data||!align||length%align||!length||(format!=1&&format!=3)||(format==3&&bits!=32)||(format==1&&bits!=8&&bits!=16&&bits!=24&&bits!=32))throw std::runtime_error("Unsupported or incomplete WAV sample format");
    const auto values=length/(bits/8);if(values>32*1024*1024)throw std::runtime_error("Decoded WAV exceeds 128 MiB");clip.samples.reserve(values);
    for(std::size_t i=0;i<values;++i){const auto p=offset+i*(bits/8);double sample=0;
        if(format==3)sample=std::bit_cast<float>(b.le(p));else if(bits==8)sample=(int(b.le(p,1))-128)/128.;else if(bits==16)sample=static_cast<std::int16_t>(b.le(p,2))/32768.;else if(bits==24){const auto v=b.le(p,3);sample=(v&0x800000?std::int64_t(v)-0x1000000:std::int64_t(v))/8388608.;}else sample=static_cast<std::int32_t>(b.le(p))/2147483648.;
        if(!std::isfinite(sample))throw std::runtime_error("Non-finite WAV sample");clip.samples.push_back(float(std::clamp(sample,-1.,1.)));
    }return clip;
}
std::vector<std::int16_t> decode_audio_frames(std::span<const std::uint8_t> source,unsigned codec,std::size_t count,AdpcmState& h){
    if(count>16*1024*1024)throw std::runtime_error("Decoded audio channel exceeds its limit");std::vector<std::int16_t> output;output.reserve(count);
    if(codec==9){if(count>source.size())throw std::runtime_error("Truncated signed PCM audio");for(std::size_t i=0;i<count;++i)output.push_back(std::int16_t(static_cast<std::int8_t>(source[i]))*256);return output;}
    const unsigned stride=codec==5?16:codec==10?15:0;if(!stride)throw std::runtime_error("Unsupported audio codec");const auto frames=(count+27)/28;if(frames>source.size()/stride)throw std::runtime_error("Truncated ADPCM frames");
    // [Trailmap: 260-eaxa, 260-psadpcm] Fixed-point recurrence, with explicit
    // nibble order and clamped/unclamped history according to the codec.
    constexpr std::array<std::array<int,2>,5> ps{{{0,0},{60,0},{115,-52},{98,-55},{122,-60}}};
    constexpr std::array<std::array<int,2>,4> ea{{{0,0},{240,0},{460,-208},{392,-220}}};
    for(std::size_t f=0;f<frames;++f){const auto p=f*stride;const unsigned predictor=source[p]>>4,shift=source[p]&15;if(codec==10&&predictor>=ea.size())throw std::runtime_error("Invalid EA-XA predictor");const auto coefficients=codec==10?ea[predictor]:ps[predictor<ps.size()?predictor:0];
        for(unsigned i=0;i<28;++i){const auto byte=source[p+(codec==5?2:1)+i/2];int nibble=codec==5?(i&1?byte>>4:byte&15):(i&1?byte&15:byte>>4);if(nibble>=8)nibble-=16;
            const auto sample=codec==10?((std::int64_t(nibble)*(std::int64_t(1)<<(20-shift))+coefficients[0]*h.first+coefficients[1]*h.second+128)>>8):((std::int64_t(nibble)*4096)>>shift)+((coefficients[0]*h.first+coefficients[1]*h.second)>>6);
            const auto clamped=std::clamp<std::int64_t>(sample,-32768,32767);h.second=h.first;h.first=codec==10?clamped:sample;if(output.size()<count)output.push_back(static_cast<std::int16_t>(clamped));
        }
    }return output;
}
void write_wave(const std::filesystem::path& path,const PcmClip& clip){
    if(clip.channels<1||clip.channels>2||clip.rate<8000||clip.rate>192000||clip.samples.size()%clip.channels||clip.samples.size()>32*1024*1024)throw std::runtime_error("Invalid output PCM");std::ofstream file(path,std::ios::binary);const auto le=[&](std::uint32_t value,unsigned width){for(unsigned i=0;i<width;++i)file.put(char((value>>(8*i))&255));};
    file<<"RIFF";le(std::uint32_t(clip.samples.size()*2+36),4);file<<"WAVEfmt ";le(16,4);le(1,2);le(clip.channels,2);le(clip.rate,4);le(clip.rate*clip.channels*2,4);le(clip.channels*2,2);le(16,2);file<<"data";le(std::uint32_t(clip.samples.size()*2),4);
    for(const auto sample:clip.samples){if(!std::isfinite(sample))throw std::runtime_error("Non-finite output audio sample");const auto value=std::clamp(std::lround(double(sample)*32768),-32768l,32767l);le(static_cast<std::uint16_t>(value),2);}if(!file)throw std::runtime_error("Cannot write PCM WAV");
}
}
