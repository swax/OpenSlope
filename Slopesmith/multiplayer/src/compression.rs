//! Soketto's extension negotiates no context takeover. Bound inflation before allocating a full output.
use soketto::{
    BoxedError, Storage,
    base::Header,
    extension::{Extension, Param, deflate::Deflate},
};

#[derive(Debug)]
pub struct BoundedDeflate {
    inner: Deflate,
    fragmented: bool,
    buffer: Vec<u8>,
}
impl BoundedDeflate {
    pub fn new() -> Self {
        Self {
            inner: Deflate::new(soketto::Mode::Server),
            fragmented: false,
            buffer: vec![0; 16 * 1024 + 1],
        }
    }
}
impl Extension for BoundedDeflate {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn is_enabled(&self) -> bool {
        self.inner.is_enabled()
    }
    fn params(&self) -> &[Param<'_>] {
        self.inner.params()
    }
    fn configure(&mut self, params: &[Param<'_>]) -> Result<(), BoxedError> {
        // Browsers usually offer only client_max_window_bits. RFC 7692 permits the server to require
        // both no-context-takeover flags without an offer; explicitly negotiate what our decoder assumes.
        let mut offered = params.to_vec();
        for name in ["server_no_context_takeover", "client_no_context_takeover"] {
            if !offered.iter().any(|p| p.name() == name) {
                offered.push(Param::new(name));
            }
        }
        self.inner.configure(&offered)
    }
    fn reserved_bits(&self) -> (bool, bool, bool) {
        self.inner.reserved_bits()
    }
    fn encode(&mut self, header: &mut Header, data: &mut Storage<'_>) -> Result<(), BoxedError> {
        self.inner.encode(header, data)
    }
    fn decode(&mut self, header: &mut Header, data: &mut Vec<u8>) -> Result<(), BoxedError> {
        use soketto::base::OpCode;
        match header.opcode() {
            OpCode::Text | OpCode::Binary if header.is_rsv1() => {
                if !header.is_fin() {
                    self.fragmented = true;
                    return Ok(());
                }
            }
            OpCode::Continue if header.is_fin() && self.fragmented => {
                self.fragmented = false;
            }
            _ => return Ok(()),
        }
        data.extend_from_slice(&[0, 0, 255, 255]);
        let mut decoder = flate2::Decompress::new(false);
        decoder.decompress(data, &mut self.buffer, flate2::FlushDecompress::Sync)?;
        let written = decoder.total_out() as usize;
        if written > 16 * 1024 || decoder.total_in() as usize != data.len() {
            return Err("inflated message too large".into());
        }
        data.clear();
        data.extend_from_slice(&self.buffer[..written]);
        header.set_rsv1(false);
        header.set_payload_len(data.len());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn browser_offer_negotiates_stateless_compression_in_both_directions() {
        let mut extension = BoundedDeflate::new();
        extension
            .configure(&[Param::new("client_max_window_bits")])
            .unwrap();
        assert!(extension.is_enabled());
        assert!(
            extension
                .params()
                .iter()
                .any(|p| p.name() == "client_no_context_takeover")
        );
        assert!(
            extension
                .params()
                .iter()
                .any(|p| p.name() == "server_no_context_takeover")
        );
    }
    #[test]
    fn inflated_size_is_bounded() {
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&vec![b'x'; 32 * 1024]).unwrap();
        let mut payload = encoder.finish().unwrap();
        let mut header = Header::new(soketto::base::OpCode::Text);
        header.set_rsv1(true);
        assert!(
            BoundedDeflate::new()
                .decode(&mut header, &mut payload)
                .is_err()
        );
    }
    #[test]
    fn accepts_a_browser_sync_flush_without_a_final_block() {
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(b"{\"t\":\"ping\",\"at\":123}").unwrap();
        encoder.flush().unwrap();
        let encoded = encoder.get_ref();
        let mut payload = encoded[..encoded.len() - 4].to_vec();
        let mut header = Header::new(soketto::base::OpCode::Text);
        header.set_rsv1(true);
        BoundedDeflate::new()
            .decode(&mut header, &mut payload)
            .unwrap();
        assert_eq!(payload, b"{\"t\":\"ping\",\"at\":123}");
    }
}
