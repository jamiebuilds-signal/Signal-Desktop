// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { type JSX } from 'react';
import { useDispatch } from 'react-redux';
import {
  useLoaderData,
  Route,
  Navigate,
  type LoaderFunction,
} from 'react-router-dom';

import { ArtType } from '../constants';
import { reset, initializeFromFork } from '../slices/art';
import type { InitializeFromForkPayload } from '../slices/art';
import { getForkPayload } from '../util/api';
import { DropStage } from './art/DropStage';
import { EmojiStage } from './art/EmojiStage';
import { UploadStage } from './art/UploadStage';
import { MetaStage } from './art/MetaStage';
import { ShareStage } from './art/ShareStage';

export type LoaderData = Readonly<{
  artType: ArtType;
}>;

const artTypeBySearchParam = new Map<string, ArtType>([
  ['sticker', ArtType.Sticker],
]);

const startFlow: LoaderFunction = ({ request }) => {
  const url = new URL(request.url);
  const artType = artTypeBySearchParam.get(
    url.searchParams.get('artType') ?? ''
  );
  if (artType === undefined) {
    throw new Error('Unsupported art type');
  }
  return { artType };
};

function Index() {
  const dispatch = useDispatch();
  const { artType } = useLoaderData() as LoaderData;

  dispatch(reset(artType));

  return <Navigate to="/art/drop" replace />;
}

type ForkLoaderData = Readonly<{
  payload: InitializeFromForkPayload;
}>;

const forkFlow: LoaderFunction = async () => {
  const payload = await getForkPayload();
  if (!payload) {
    throw new Error('No fork payload available');
  }
  return { payload } satisfies ForkLoaderData;
};

function ForkIndex() {
  const dispatch = useDispatch();
  const { payload } = useLoaderData() as ForkLoaderData;

  dispatch(initializeFromFork(payload));

  return <Navigate to="/art/drop" replace />;
}

export function createArtRoutes(): JSX.Element {
  return (
    <Route path="/art">
      <Route index loader={startFlow} element={<Index />} />
      <Route path="/art/fork" loader={forkFlow} element={<ForkIndex />} />
      <Route path="/art/drop" element={<DropStage />} />
      <Route path="/art/add-emojis" element={<EmojiStage />} />
      <Route path="/art/add-meta" element={<MetaStage />} />
      <Route path="/art/upload" element={<UploadStage />} />
      <Route path="/art/share" element={<ShareStage />} />
      <Route path="/art/*" element={<Navigate to="/" replace />} />
    </Route>
  );
}
