// 기사 본문을 읽고 단어·문항·쓰기 과제를 만든다.
// 이 부분만 사람의 판단이 필요해서 Claude 에게 맡긴다. 나머지는 전부 규칙으로 처리한다.
import Anthropic from '@anthropic-ai/sdk';

const TOPICS = ['Space','Science','History','Animals','Environment','Sports',
                'Arts','Entertainment','Government','Business','Culture','Technology'];

const LEVEL_GUIDE = {
  K1: '유치원~1학년. 한 문장은 아주 짧게. 보기는 한 단어 위주. 답은 기사 문장을 거의 그대로 옮기면 되도록.',
  G2: '2학년. 짧고 쉬운 문장. 답은 기사에서 찾을 수 있게.',
  'G3-4': '3~4학년. 한 문장에 정보 두 개까지. 이유를 묻는 문항을 하나 넣어도 좋다.',
  'G5-6': '5~6학년. 추론이 한 단계 필요한 문항을 한두 개 넣어도 좋다. 다만 답의 근거는 기사 안에 있어야 한다.',
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'note', 'vocabulary', 'questions', 'writing'],
  properties: {
    topic: { type: 'string', enum: TOPICS, description: '기사 주제' },
    note: { type: 'string', description: '기사를 한 줄로 설명하는 한국어 메모' },
    vocabulary: {
      type: 'array', minItems: 4, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false, required: ['word', 'meaning'],
        properties: {
          word: { type: 'string', description: '기사에 실제로 나오는 영어 낱말' },
          meaning: { type: 'string', description: '한국어 뜻' },
        },
      },
    },
    questions: {
      type: 'array', minItems: 5, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'q', 'answer'],
        properties: {
          type: { type: 'string', enum: ['mc', 'short'] },
          q: { type: 'string', description: '영어 문항' },
          choices: { type: 'array', items: { type: 'string' }, description: 'mc 일 때 보기 4개' },
          answer: { type: 'string', description: 'mc 는 정답 보기의 글자 그대로, short 는 영어 모범답안' },
          note: { type: 'string', description: '채점할 때 참고할 한국어 설명' },
        },
      },
    },
    writing: {
      type: 'object', additionalProperties: false,
      required: ['prompt', 'sample'],
      properties: {
        prompt: { type: 'string', description: '영어 쓰기 과제' },
        sample: { type: 'string', description: '채점 기준을 적은 한국어 설명' },
      },
    },
  },
};

const SYSTEM = `당신은 초등 영어 교사를 돕는다. 영자신문 기사로 워크시트 문항을 만든다.

지켜야 할 것:
- 문항과 보기는 영어로, 낱말 뜻과 채점 설명은 한국어로 쓴다.
- 답의 근거는 반드시 기사 안에 있어야 한다. 기사에 없는 사실을 묻지 않는다.
- 객관식 보기 네 개는 길이가 비슷해야 한다. 정답만 길면 아이가 내용을 몰라도 맞힌다.
- 오답도 그럴듯해야 한다. 아무 상관 없는 보기는 문항을 쉽게 만든다.
- 낱말은 기사에 실제로 나온 것만 고른다.
- 객관식과 서술형을 섞는다. 객관식 세 개 안팎이 적당하다.`;

/** 문단과 소제목을 읽기 좋은 형태로 편다. */
function passageOf(article) {
  if (article.blocks?.length) {
    return article.blocks
      .filter((b) => b.type !== 'image')
      .map((b) => (b.type === 'heading' ? `## ${b.text}` : b.text))
      .join('\n\n');
  }
  return (article.paragraphs || []).join('\n\n');
}

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function generateWorksheet({ title, level, article }, { log = () => {} } = {}) {
  const client = new Anthropic();
  const passage = passageOf(article);

  const res = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 16000,
    system: SYSTEM,
    tools: [{
      name: 'write_worksheet',
      description: '워크시트의 낱말, 문항, 쓰기 과제를 채운다.',
      input_schema: SCHEMA,
      strict: true,
    }],
    tool_choice: { type: 'tool', name: 'write_worksheet' },
    messages: [{
      role: 'user',
      content: `기사 제목: ${title}
리딩 레벨: ${level} (${LEVEL_GUIDE[level] || ''})

기사 본문 ('##' 로 시작하는 줄은 사진 설명 소제목입니다):

${passage}`,
    }],
  });

  if (res.stop_reason === 'refusal') {
    throw new Error(`문항 생성이 거절됐습니다: ${res.stop_details?.explanation || '사유 없음'}`);
  }
  const call = res.content.find((b) => b.type === 'tool_use');
  if (!call) throw new Error('문항을 돌려받지 못했습니다.');

  const out = call.input;
  log(`문항 생성 완료 · 낱말 ${out.vocabulary.length} 문항 ${out.questions.length}`);

  // 워크시트 형식에 맞춰 옮긴다. 객관식 정답은 번호로 바꿔 넣는다.
  return {
    topic: out.topic,
    note: out.note,
    vocabulary: out.vocabulary,
    questions: out.questions.map((q) => {
      if (q.type === 'mc') {
        const idx = (q.choices || []).indexOf(q.answer);
        if (idx < 0) throw new Error(`객관식 정답이 보기에 없습니다: ${q.q}`);
        return { type: 'mc', q: q.q, choices: q.choices, answer: idx };
      }
      return { type: 'short', q: q.q, lines: 2, answer: q.answer, ...(q.note ? { note: q.note } : {}) };
    }),
    writing: { prompt: out.writing.prompt, lines: 4, sample: out.writing.sample },
  };
}
