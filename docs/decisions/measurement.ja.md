# Measurement decisions

> For the English version, see [measurement.md](measurement.md).

ラウドネスの計測について閉じた判断のうち、この拡張機能だけに当たるもの。計測の仕組みは `AGENTS.md` の「Key design decisions」にある。種 (計測の初めに入れておく保存値) に与える重み、つまり下限と上限は、共有のメーターについての決定で、channel-volume-core の [docs/decisions/measurement.ja.md](https://github.com/semnil/channel-volume-core/blob/main/docs/decisions/measurement.ja.md) に記録する。

## The popup does not tell a seeded value from a measured one

- **決定** (2026-08-23): popup は、Integrated の値がまだ種の上に立っているときも、ページを開いてから計測した音の上に立っているときも、同じ形で表示する。「今出ている値は前回のセッションのもの」と伝える表示は置かない。
- **理由**: 計測は保存済みの LUFS を種にして始まるので、Integrated は種を入れた時点から有限の数になる。保存値を持つチャンネルでは、Fallback のバッジ (Auto がオンで、Integrated がまだ得られていない間に出る) が出る時間が、事実上無い。2 つを見分ける表示を足すかどうかを問いとして挙げ、区別しないと決まった。
