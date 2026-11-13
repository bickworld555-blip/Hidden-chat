package io.github.bickworld555.hiddenchat;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.effect.Presentation;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.DefaultEncoderFactory;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.Transformer;
import androidx.media3.transformer.VideoEncoderSettings;
import java.io.File;
import java.util.Collections;

/**
 * Settings › Storage and data › Media upload quality › Standard: a video is re-encoded on the phone (H.264 + AAC,
 * at most 720p on its short side, a WhatsApp-like bitrate) before it is encrypted and uploaded. HD sends the
 * original. Uses the phone's hardware encoder through Media3 Transformer; runs on the main looper as it requires.
 */
final class VideoCompressor {
    interface Done {
        void ok(File output);

        void fail(String reason);
    }

    private VideoCompressor() {}

    static void compress(Context context, File input, File output, int shortSide, int bitrate, Done done) {
        Context app = context.getApplicationContext();
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                DefaultEncoderFactory encoders = new DefaultEncoderFactory.Builder(app)
                    .setRequestedVideoEncoderSettings(new VideoEncoderSettings.Builder().setBitrate(bitrate).build())
                    .build();
                Transformer transformer = new Transformer.Builder(app)
                    .setVideoMimeType(MimeTypes.VIDEO_H264)
                    .setAudioMimeType(MimeTypes.AUDIO_AAC)
                    .setEncoderFactory(encoders)
                    .addListener(new Transformer.Listener() {
                        @Override
                        public void onCompleted(Composition composition, ExportResult result) {
                            done.ok(output);
                        }

                        @Override
                        public void onError(Composition composition, ExportResult result, ExportException error) {
                            output.delete();
                            done.fail(error.getMessage() == null ? "The video could not be compressed." : error.getMessage());
                        }
                    })
                    .build();
                EditedMediaItem item = new EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(input)))
                    .setEffects(new Effects(Collections.emptyList(), Collections.singletonList(Presentation.createForShortSide(shortSide))))
                    .build();
                transformer.start(item, output.getAbsolutePath());
            } catch (RuntimeException error) {
                output.delete();
                done.fail(error.getMessage() == null ? "The video could not be compressed." : error.getMessage());
            }
        });
    }
}
