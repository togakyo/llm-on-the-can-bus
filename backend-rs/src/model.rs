//! model — candle による Qwen2 系モデルのネイティブ推論（feature = "llm" のときのみ）。
//!
//! Hugging Face Hub から config/tokenizer/safetensors を取得し、意図から照明DSLを生成する。
//! 生成結果は planner_core::normalize_dsl で矯正され、後段の安全審査を必ず通る。

use anyhow::{anyhow, Result};
use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::qwen2::{Config, ModelForCausalLM};
use tokenizers::Tokenizer;

use crate::planner_core::{self, fewshot, system_prompt};

pub struct QwenPlanner {
    model: ModelForCausalLM,
    tokenizer: Tokenizer,
    device: Device,
    im_end_id: u32,
    eos_id: u32,
    pub model_id: String,
    pub device_label: String,
}

impl QwenPlanner {
    pub fn load(model_id: &str) -> Result<Self> {
        use hf_hub::api::sync::Api;
        let api = Api::new()?;
        let repo = api.model(model_id.to_string());
        let config_path = repo.get("config.json")?;
        let tokenizer_path = repo.get("tokenizer.json")?;
        let weights_path = repo.get("model.safetensors")?;

        let config: Config = serde_json::from_slice(&std::fs::read(config_path)?)?;
        let tokenizer = Tokenizer::from_file(tokenizer_path).map_err(|e| anyhow!("tokenizer: {e}"))?;

        // Apple Silicon(Metal) が使えれば使う。無ければ CPU。
        let (device, device_label) = pick_device();
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path], DType::F32, &device)?
        };
        let model = ModelForCausalLM::new(&config, vb)?;

        let im_end_id = tokenizer.token_to_id("<|im_end|>").unwrap_or(151645);
        let eos_id = tokenizer.token_to_id("<|endoftext|>").unwrap_or(151643);

        Ok(Self {
            model,
            tokenizer,
            device,
            im_end_id,
            eos_id,
            model_id: model_id.to_string(),
            device_label,
        })
    }

    /// Qwen の chat テンプレートを組み立てる（system + few-shot + user）。
    fn build_prompt(&self, intent: &str) -> String {
        let mut p = format!("<|im_start|>system\n{}<|im_end|>\n", system_prompt());
        for (user, asst) in fewshot() {
            p.push_str(&format!(
                "<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n{asst}<|im_end|>\n"
            ));
        }
        p.push_str(&format!("<|im_start|>user\n{intent}<|im_end|>\n<|im_start|>assistant\n"));
        p
    }

    /// 意図 → 正規化済み DSL。生成テキストから JSON を抽出し normalize する。
    pub fn generate(&mut self, intent: &str) -> Result<serde_json::Value> {
        let prompt = self.build_prompt(intent);
        let encoding = self
            .tokenizer
            .encode(prompt, false)
            .map_err(|e| anyhow!("encode: {e}"))?;
        let tokens: Vec<u32> = encoding.get_ids().to_vec();

        self.model.clear_kv_cache();

        let mut generated: Vec<u32> = Vec::new();
        let mut ctxt = tokens;
        let mut pos = 0usize;
        let max_new_tokens = 320usize;

        for _ in 0..max_new_tokens {
            let input = Tensor::new(ctxt.as_slice(), &self.device)?.unsqueeze(0)?;
            let logits = self.model.forward(&input, pos)?; // (1, 1, vocab)
            pos += ctxt.len();

            let logits = logits.squeeze(0)?.squeeze(0)?.to_dtype(DType::F32)?;
            let next = argmax(&logits)?;
            if next == self.im_end_id || next == self.eos_id {
                break;
            }
            generated.push(next);
            ctxt = vec![next];
        }

        let text = self
            .tokenizer
            .decode(&generated, true)
            .map_err(|e| anyhow!("decode: {e}"))?;

        match planner_core::extract_json(&text) {
            Some(v) => Ok(planner_core::normalize_dsl(&v)),
            None => Err(anyhow!("model output had no valid JSON")),
        }
    }
}

fn argmax(logits: &Tensor) -> Result<u32> {
    let v: Vec<f32> = logits.to_vec1()?;
    let mut best = 0usize;
    let mut best_val = f32::NEG_INFINITY;
    for (i, &x) in v.iter().enumerate() {
        if x > best_val {
            best_val = x;
            best = i;
        }
    }
    Ok(best as u32)
}

fn pick_device() -> (Device, String) {
    #[cfg(feature = "metal")]
    {
        if let Ok(d) = Device::new_metal(0) {
            return (d, "metal".to_string());
        }
    }
    #[cfg(feature = "cuda")]
    {
        if let Ok(d) = Device::cuda_if_available(0) {
            if d.is_cuda() {
                return (d, "cuda".to_string());
            }
        }
    }
    (Device::Cpu, "cpu".to_string())
}
