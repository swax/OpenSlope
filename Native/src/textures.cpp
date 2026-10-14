#include "import_internal.hpp"
#include <algorithm>
#include <array>
#include <fstream>
#include <set>

namespace openslope::import_detail {
namespace {
void finish_texture(Image& image) {
    // Displayed course banks use the canonical unconditional modulate2x
    // conversion. Lightmap RGBA never passes through this function.
    for(std::size_t p=0;p<image.rgba.size();p+=4)for(unsigned c=0;c<3;++c)image.rgba[p+c]=static_cast<std::uint8_t>(std::clamp(int(image.rgba[p+c])*2-1,0,255));
    // Application policy: accept associated alpha only if every fractional
    // texel satisfies RGB <= alpha, the mathematical bound for normalized
    // associated colour. No sample-count thresholds or tolerated violations.
    // This is a conservative inference, not a property declared by the format.
    bool fractional=false;
    for(std::size_t p=0;p<image.rgba.size();p+=4){const auto alpha=image.rgba[p+3];if(alpha==0||alpha==255)continue;fractional=true;
        if(std::any_of(image.rgba.begin()+static_cast<std::ptrdiff_t>(p),image.rgba.begin()+static_cast<std::ptrdiff_t>(p+3),[alpha](auto colour){return colour>alpha;}))return;
    }
    if(!fractional)return;
    for(std::size_t p=0;p<image.rgba.size();p+=4){const auto alpha=image.rgba[p+3];if(alpha==0||alpha==255)continue;for(unsigned c=0;c<3;++c)image.rgba[p+c]=static_cast<std::uint8_t>((unsigned(image.rgba[p+c])*255u+alpha/2u)/alpha);}
}
void append_be(std::vector<std::uint8_t>& bytes,std::uint32_t v){for(int shift=24;shift>=0;shift-=8)bytes.push_back(static_cast<std::uint8_t>(v>>shift));}
std::uint32_t crc(std::span<const std::uint8_t> bytes){std::uint32_t v=0xffffffff;for(auto b:bytes){v^=b;for(unsigned i=0;i<8;++i)v=(v>>1)^((v&1)?0xedb88320:0);}return ~v;}
void chunk(std::ofstream& file,const char* type,std::span<const std::uint8_t> bytes){
    std::vector<std::uint8_t> block;append_be(block,static_cast<std::uint32_t>(bytes.size()));block.insert(block.end(),type,type+4);block.insert(block.end(),bytes.begin(),bytes.end());const auto checksum=crc(std::span(block).subspan(4));append_be(block,checksum);file.write(reinterpret_cast<const char*>(block.data()),static_cast<std::streamsize>(block.size()));
}
}
// [Trailmap: 210-directory, 210-chunk, 210-types, 210-palette, 210-swizzle,
// 210-alpha, 210-color] All reads are bounded by directory/chunk extents.
std::vector<Image> decode_ssh(std::span<const std::uint8_t> data,bool lightmap,const ImportCancel& cancelled,bool particle) {
    Bytes bank{data};bank.range(0,16);
    if(bank.text(0,4)!="SHPS"||bank.le(4)!=data.size())throw std::runtime_error("Unsupported or truncated PS2 SSH texture bank");
    const auto count=bank.le(8);if(!count||count>4096)throw std::runtime_error("Invalid SSH image count");bank.range(16,std::size_t(count)*8);
    std::vector<Image> result;std::set<std::string> names;std::size_t memory=0;
    for(std::size_t i=0;i<count;++i) {
        check_cancel(cancelled);auto name=bank.text(16+i*8,4);while(!name.empty()&&(name.back()=='\0'||name.back()==' '))name.pop_back();
        if(!valid_map_name(name)||!names.insert(name).second)throw std::runtime_error("Unsafe or duplicate texture name");
        const auto start=bank.le(20+i*8);const std::size_t end=i+1<count?bank.le(28+i*8):data.size();
        if(start<16+count*8||end<=start||end>data.size())throw std::runtime_error("Invalid SSH image extent");
        Bytes image{data.subspan(start,end-start)};std::size_t cursor=0,pixels_offset=0,palette_offset=0,palette_count=0;unsigned type=0,flags=0,palette_flags=0,width=0,height=0;bool metal=false;
        while(cursor+16<=image.data.size()) {
            if(image.text(cursor,8)=="Buy ERTS"||image.text(cursor,8)=="EASports")break;
            const auto kind=image.le(cursor,1),declared=image.le(cursor+1,3);std::size_t size=declared;
            if(kind==1||kind==2||kind==5) {
                if(type)throw std::runtime_error("SSH mip chains are unsupported");type=kind;width=image.le(cursor+4,2);height=image.le(cursor+6,2);flags=image.le(cursor+12);
                if(!width||!height||width>4096||height>4096)throw std::runtime_error("Invalid SSH dimensions");
                const auto payload=(std::size_t(width)*height*(kind==5?32:kind==2?8:4)+7)/8;pixels_offset=cursor+16;image.range(pixels_offset,payload);if(!size)size=16+payload;
                if(size<16+payload)throw std::runtime_error("SSH pixel chunk is too short");
            } else if(kind==33){palette_count=image.le(cursor+4,2);if(!palette_count||palette_count>256)throw std::runtime_error("Invalid SSH palette size");palette_flags=image.le(cursor+12);palette_offset=cursor+16;image.range(palette_offset,palette_count*4);if(!size)size=16+palette_count*4;}
            else if(kind==105){metal=true;if(!size)size=16;}
            else if(kind==112){size=4;while(cursor+size<image.data.size()&&image.data[cursor+size])++size;++size;size=((cursor+size+15)&~std::size_t(15))-cursor;}
            else if(kind==124){size=(8+std::size_t(image.le(cursor+4))*8+15)&~std::size_t(15);}
            else throw std::runtime_error("Unsupported SSH chunk type "+std::to_string(kind));
            if(size<16)throw std::runtime_error("Invalid SSH chunk size");image.range(cursor,size);cursor+=size;
        }
        if(!type||((type==1||type==2)&&!palette_count)||(lightmap&&type!=5))throw std::runtime_error("SSH image or lightmap format is unsupported");
        if(flags&~8192u||palette_flags&~8192u||(flags&&type!=2))throw std::runtime_error("Unsupported SSH swizzle flags");
        const auto length=std::size_t(width)*height*4;memory+=length;if(memory>128*1024*1024)throw std::runtime_error("SSH bank exceeds image memory limit");
        Image decoded{name,width,height,std::vector<std::uint8_t>(length)};
        std::vector<std::uint8_t> palette;
        if(palette_count){palette.resize(palette_count*4);for(std::size_t c=0;c<palette_count;++c){const auto source=palette_flags?((c&0xe7)|((c&8)<<1)|((c&16)>>1)):c;if(source>=palette_count)throw std::runtime_error("Swizzled palette exceeds its count");std::copy_n(image.data.begin()+static_cast<std::ptrdiff_t>(palette_offset+source*4),4,palette.begin()+static_cast<std::ptrdiff_t>(c*4));}
            bool half_alpha=!metal;for(std::size_t c=3;c<palette.size();c+=4)if(palette[c]>128)half_alpha=false;
            if(half_alpha)for(std::size_t c=3;c<palette.size();c+=4)palette[c]=static_cast<std::uint8_t>(std::min(255,int(palette[c])*2));
        }
        for(unsigned y=0;y<height;++y)for(unsigned x=0;x<width;++x) {
            const std::size_t p=std::size_t(y)*width+x;std::size_t source=p;
            if(flags){const auto block=(y&~15u)*width+(x&~15u)*2;const auto swap=(((y+2)>>2)&1)*4;const auto pos_y=(((y&~3u)>>1)+(y&1))&7;source=block+pos_y*width*2+((x+swap)&7)*4+((y>>1)&1)+((x>>2)&2);}
            if(type==5)std::copy_n(image.data.begin()+static_cast<std::ptrdiff_t>(pixels_offset+p*4),4,decoded.rgba.begin()+static_cast<std::ptrdiff_t>(p*4));
            else {image.range(pixels_offset+source/(type==1?2:1),1);const auto packed=image.data[pixels_offset+source/(type==1?2:1)];const std::size_t index=type==1?((packed>>((source&1)*4))&15):packed;if(index>=palette_count)throw std::runtime_error("SSH pixel references missing palette entry");std::copy_n(palette.begin()+static_cast<std::ptrdiff_t>(index*4),4,decoded.rgba.begin()+static_cast<std::ptrdiff_t>(p*4));}
        }
        if(particle){
            // [Trailmap: 180-bank] The shared bank mixes full/half-bright art.
            // This explicit bank profile infers half range from RGB bounds and
            // keeps sprite alpha straight; course alpha inference is separate.
            bool half=true;for(std::size_t p=0;p<decoded.rgba.size();p+=4)for(unsigned c=0;c<3;++c)if(decoded.rgba[p+c]>128)half=false;
            if(half)for(std::size_t p=0;p<decoded.rgba.size();p+=4)for(unsigned c=0;c<3;++c)decoded.rgba[p+c]=std::uint8_t(std::clamp(int(decoded.rgba[p+c])*2-1,0,255));
            bool associated=true,fractional=false;for(std::size_t p=0;p<decoded.rgba.size();p+=4){const auto a=decoded.rgba[p+3];if(!a||a==255)continue;fractional=true;for(unsigned c=0;c<3;++c)if(decoded.rgba[p+c]>a)associated=false;}
            if(associated&&fractional)for(std::size_t p=0;p<decoded.rgba.size();p+=4){const auto a=decoded.rgba[p+3];if(!a||a==255)continue;for(unsigned c=0;c<3;++c)decoded.rgba[p+c]=std::uint8_t((unsigned(decoded.rgba[p+c])*255u+a/2u)/a);}
        }else if(!lightmap)finish_texture(decoded);result.push_back(std::move(decoded));
    }
    return result;
}
// PNG RGBA8, filter zero and zlib stored blocks. Avoid a new native dependency;
// PNG byte compression is not part of the portable pixel contract.
void write_png(const std::filesystem::path& path,const Image& image) {
    std::ofstream file(path,std::ios::binary);const std::array<std::uint8_t,8> signature={137,80,78,71,13,10,26,10};file.write(reinterpret_cast<const char*>(signature.data()),8);
    std::vector<std::uint8_t> header;append_be(header,image.width);append_be(header,image.height);header.insert(header.end(),{8,6,0,0,0});chunk(file,"IHDR",header);
    std::vector<std::uint8_t> scanlines;scanlines.reserve(image.rgba.size()+image.height);
    for(unsigned y=0;y<image.height;++y){scanlines.push_back(0);const auto start=std::size_t(y)*image.width*4;scanlines.insert(scanlines.end(),image.rgba.begin()+static_cast<std::ptrdiff_t>(start),image.rgba.begin()+static_cast<std::ptrdiff_t>(start+image.width*4));}
    std::vector<std::uint8_t> compressed={0x78,0x01};std::uint32_t a=1,b=0;
    for(auto value:scanlines){a=(a+value)%65521;b=(b+a)%65521;}
    for(std::size_t p=0;p<scanlines.size();){const auto size=std::min<std::size_t>(65535,scanlines.size()-p);compressed.push_back(p+size==scanlines.size()?1:0);compressed.push_back(static_cast<std::uint8_t>(size));compressed.push_back(static_cast<std::uint8_t>(size>>8));const auto complement=static_cast<std::uint16_t>(~size);compressed.push_back(static_cast<std::uint8_t>(complement));compressed.push_back(static_cast<std::uint8_t>(complement>>8));compressed.insert(compressed.end(),scanlines.begin()+static_cast<std::ptrdiff_t>(p),scanlines.begin()+static_cast<std::ptrdiff_t>(p+size));p+=size;}
    append_be(compressed,(b<<16)|a);chunk(file,"IDAT",compressed);chunk(file,"IEND",{});if(!file)throw std::runtime_error("Cannot write texture PNG");
}
}
