// Claude を待つ間も話を止めないための順番待ち

// 声メモは入れた順に1つずつ処理する。前の書き込みを見てから次を送るため
export function createQueue() {
  let last = Promise.resolve();
  return {
    add(task) {
      last = last.then(task, task);
      return last;
    },
    idle: () => last,
  };
}

// 点検は最新の計画に対して1回あればよい。途中で頼まれたら、終わってからもう一度だけ動かす
// job は isStale を受け取る。true なら答えが古いので捨てる
export function createLatest(job) {
  let running = null;
  let again = false;
  async function loop() {
    try {
      do {
        again = false;
        await job(() => again);
      } while (again);
    } finally {
      running = null;
    }
  }
  return {
    request() {
      if (running) {
        again = true;
        return running;
      }
      running = loop();
      return running;
    },
    idle: () => running ?? Promise.resolve(),
  };
}
